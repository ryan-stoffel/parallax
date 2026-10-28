// @vitest-environment happy-dom
import type { TiptapEditorHTMLElement } from "@tiptap/react";
import { act, type ReactNode } from "react";
import { createRoot } from "react-dom/client";
import { afterEach, expect, test, vi } from "vite-plus/test";

import samples from "../../../../crates/parallax-protocol/samples/v1/agents.json";
import type {
  ConnectionState,
  SubscriptionMessage,
  ParallaxBridge,
  RpcError,
  WatchMessage,
  WatchParams,
} from "../preload/bridge";
import type {
  AgentRun,
  AgentToolStatus,
  LoggedEvent,
  ThreadRun,
} from "../protocol/generated/protocol";
import { AgentChat, RowView, TranscriptView } from "./AgentChat";
import { Composer } from "./Composer";
import { threadDrafts } from "./drafts";
import { ForkContext } from "./Fork";
import "./markdownTest";
import { Notifications } from "./notifications";
import type { Item } from "./transcript";
import { fakeWatch } from "./fakeWatch";

Object.assign(globalThis, { IS_REACT_ACT_ENVIRONMENT: true });
// A web link asks main for its site's icon, which these tests have none of.
window.parallax = { siteIcon: async () => undefined } as Partial<ParallaxBridge> as ParallaxBridge;
// The real split, watched, to see which messages take it.
vi.mock("./markdownBlocks", async (actual) => {
  const real = await actual<typeof import("./markdownBlocks")>();
  return { ...real, markdownBlocks: vi.fn(real.markdownBlocks) };
});
// happy-dom has no popovers. Menus are in the DOM either way.
HTMLElement.prototype.hidePopover = () => {};
HTMLElement.prototype.showPopover = () => {};
// The notifications, outside the body, which a test's unmount clears.
const notices = document.documentElement.appendChild(document.createElement("div"));
createRoot(notices).render(<Notifications />);
// happy-dom lays nothing out. Give the transcript a tall viewport and each row a
// small height, so the virtualized list renders every row.
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
const logged = (samples as { method?: string; params?: unknown }[])
  .filter((m) => m.method === "events/event")
  .map((m) => m.params as LoggedEvent);

let unmount = () => {};
afterEach(() => {
  // Notifications outlive a render, so close this test's.
  for (const close of notices.querySelectorAll<HTMLButtonElement>('button[aria-label="Close"]'))
    act(() => close.click());
  act(() => unmount());
  vi.useRealTimers();
  vi.unstubAllGlobals();
});

function render(node: ReactNode) {
  const root = createRoot(document.body.appendChild(document.createElement("div")));
  act(() => root.render(node));
  unmount = () => {
    root.unmount();
    document.body.innerHTML = "";
    // What's left in the box would come back as a draft in the next render of the run.
    for (const key of Object.keys(threadDrafts.get())) threadDrafts.remove(key);
    unmount = () => {};
  };
  return root;
}

// The composer's editor, which Tiptap keeps on its element for tests.
const composer = () =>
  document.querySelector<TiptapEditorHTMLElement>('[role="textbox"][aria-label="Message"]')!;
const type = (text: string) => act(() => void composer().editor!.commands.setContent(text));

const row = (item: Item, open = false) =>
  render(<RowView row={item} live={false} open={open} onToggle={() => {}} />);
const said = () =>
  document.querySelector("summary :is(.sr-only, [data-slot=trace-description])")?.textContent;

test("an assistant message renders Markdown, but never raw HTML or images", async () => {
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
  // Raw HTML is its text, and a Markdown image is a link with its alt text, which a click opens
  // only as a file in the thread's folder (here, outside a thread, nothing).
  expect(document.querySelector("img")).toBeNull();
  expect(document.body.textContent).toContain("<img src=x onerror=alert(1)>");
  const links = [...document.querySelectorAll("a")];
  expect(links.map((a) => a.textContent)).toEqual(["docs", "a diagram"]);
});

test("a streaming message renders as the whole text does, at every line", async () => {
  // Past SPLIT_FROM, so each reply renders block by block.
  const lead = "A long reply opens with a paragraph. ".repeat(30) + "\n\n";
  const replies = [
    [
      "Setext\n===\n\nIntro with `code` and **bold**.",
      "- loose\n\n- list\n  continued\n\n  - nested\n\n    ```sh\n    cargo test\n\n    ```",
      "1. one\n\n2) two\n\n10. ten",
      "    indented code\n\n    more\n\n> quote\n> lines",
      "| a | b |\n| - | - |\n| 1 | 2 |\n\n---\n\n- [x] done\n- [ ] not",
      "```ts\nconst a = 1;\n\n~~~\n```\n\n~~~~\n```\n\n~~~~\n\nEnd.",
      "- tight\n- list\n\nText\n\n  ```\n  indented fence\n  ```\n\nEnd.",
    ].join("\n\n"),
    // A list item's fence that a column-0 fence ends, which opens a new one.
    "1. Run:\n   ```sh\n   cargo test\n```\n\nThen check.\n\nDone.",
    // A fence on a list marker's line.
    "- ```\n  a\n  ```\n\nText\n\n```\ncode\n\nmore\n```",
    // A fence inside an HTML block.
    "<details>\n```ts\nconst a = 1;\n\nconst b = 2;\n```\n\n</details>\n\nAfter",
    "```\r\ncode\r\n\r\nmore\r\n```\r\n\r\n- a\r\n\r\n- b\r\n-\r\n\r\nEnd",
    // Definitions inside containers.
    "See [x].\n\n> [x]: https://example.com",
    "See [x].\n\nok\n\n- [x]: https://example.com",
    "A[^1]\n\nB\n\n> [^1]: Note",
    "a\n\u00a0\nb",
    // A loose list whose next item, while it arrives, reads as a paragraph.
    "1. a\n\n2. b\n\n3. c\n\nText\n\n- d\n\n- e",
    // Math in each delimiter, beside prices.
    "From $5 to $10, so \\(a^2\\) and $b$.\n\n\\[\nx = 1\n\\]\n\n$$\ny = 2\n$$\n\nEnd.",
  ];
  // A row in a root of its own, which keeps it across renders, as the transcript does.
  const view = () => {
    const container = document.createElement("div");
    const root = createRoot(container);
    return async (text: string, partial: boolean) => {
      const row: Item = { kind: "assistant", key: "a", text, partial };
      act(() => root.render(<RowView row={row} live={false} open={false} onToggle={() => {}} />));
      // A streaming message differs by its class, which hides LaTeX still arriving, and by each
      // block's own Enriched Markdown root, whose last margin it zeroes: the elements are the same.
      const shape = container.cloneNode(true) as HTMLElement;
      for (const root of shape.querySelectorAll(".enrm-text")) root.replaceWith(...root.childNodes);
      for (const styled of shape.querySelectorAll("[style]")) styled.removeAttribute("style");
      // An element React updated keeps its attributes' first order, one it made has its own.
      for (const el of shape.querySelectorAll("*")) {
        const attributes = [...el.attributes]
          .map((a) => [a.name, a.value] as const)
          .sort(([a], [b]) => a.localeCompare(b));
        for (const [name] of attributes) el.removeAttribute(name);
        for (const [name, value] of attributes) el.setAttribute(name, value);
      }
      return shape.innerHTML.replaceAll(">\n<", "><").replace('"enriched streaming"', '"enriched"');
    };
  };
  for (const reply of replies.map((r) => lead + r)) {
    const streaming = view();
    // Each length that ends a line or stops in its first characters, which decide its kind.
    for (let n = 1; n <= reply.length; n++) {
      const column = n - 1 - reply.lastIndexOf("\n", n - 1);
      if (column > 4 && n < reply.length && reply[n] !== "\n") continue;
      const text = reply.slice(0, n);
      expect(await streaming(text, true), JSON.stringify(text)).toBe(await view()(text, false));
    }
  }
  // Hundreds of renders, a few seconds when other files run alongside.
}, 30_000);

// The sample's run, as it started.
const sampleRun = (logged[0]!.event as { run: AgentRun }).run;

/**
 * The messages the chat sent, as `message.dispatch` commands (0059), each as a call with its
 * thread and message ids under the names `agent/send` gave them, and its dispatch mode as a
 * `delivery`.
 */
function sendCalls(request: { mock: { calls: unknown[][] } }) {
  return request.mock.calls
    .filter(
      ([, method, params]) =>
        method === "orchestration/dispatch" &&
        (params as { type: string }).type === "message.dispatch",
    )
    .map(([host, , params]) => {
      const p = params as { threadId: string; messageId: string; dispatchMode: { type: string } };
      const delivery = p.dispatchMode.type === "steer_active" ? "steer" : "queue";
      return [host, "agent/send", { ...p, runId: p.threadId, turnId: p.messageId, delivery }];
    });
}

/**
 * A bridge serving the sample's events up to `seq`, two per page, that records calls.
 * `agent/list` answers `listSeq`, and a subscribe from before it resyncs, as plxd does
 * when it can't replay that far back. The first `resyncs` subscribes resync anyway.
 * plxd advertises `capabilities`, `message.dispatch` fails when `sent` leaves the run failed,
 * and `agent/image` answers a tiny PNG.
 * `connect` changes the connection's state, and `traffic` moves the scope's log to `listSeq`.
 */
function fakeBridge(
  seq: number,
  {
    listSeq = seq,
    resyncs = 0,
    cancelError = "",
    capabilities = {},
    sent = {} as Partial<AgentRun>,
  } = {},
) {
  let listener: (m: SubscriptionMessage) => void = () => {};
  const connections = new Set<(hostId: string, state: ConnectionState) => void>();
  type Params = { after?: number; before?: number; type?: string };
  const request = vi.fn(async (_host: string, method: string, params: Params) => {
    if (method === "queue/list") return { result: { messages: [] }, logId: "log-1" };
    if (method === "agent/list") return { result: { runs: [], seq: listSeq }, logId: "log-1" };
    if (method === "orchestration/threadRuns") return { result: { runs: [] }, logId: "log-1" };
    const command = (params as { type?: string }).type;
    if ((method === "agent/cancel" || command === "run.interrupt") && cancelError)
      return { error: { code: -32000, message: cancelError } };
    // A run whose CLI didn't start again fails the message, and no turn follows.
    if (command === "message.dispatch" && sent.status === "failed")
      return { error: { code: -32603, message: sent.error ?? "The agent couldn't start." } };
    if (method === "orchestration/dispatch") return { result: { seq: 1 }, logId: "log-1" };
    if (method === "agent/image")
      return { result: { mediaType: "image/png", data: "AAAA" }, logId: "log-1" };
    if (method !== "agent/events") return { result: {}, logId: "log-1" };
    if (params.before !== undefined) {
      const older = logged.filter((e) => e.seq < params.before! && e.seq <= seq);
      return {
        result: { events: older.slice(-2), more: older.length > 2, run: sampleRun, seq: listSeq },
        logId: "log-1",
      };
    }
    const rest = logged.filter((e) => e.seq > params.after! && e.seq <= seq);
    return { result: { events: rest.slice(0, 2), more: rest.length > 2 }, logId: "log-1" };
  });
  const unsubscribe = vi.fn();
  const subscribe = vi.fn((_host: string, params: { after: number }, l: typeof listener) => {
    listener = l;
    if (params.after < listSeq || resyncs-- > 0) queueMicrotask(() => l({ type: "resync" }));
    return unsubscribe;
  });
  window.parallax = {
    platform: "darwin",
    connectionState: async () => ({
      status: "connected",
      plxd: "0.1.0",
      protocol: 1,
      capabilities,
    }),
    onConnectionState: (l: (hostId: string, state: ConnectionState) => void) => {
      connections.add(l);
      return () => connections.delete(l);
    },
    request,
    watch: fakeWatch(() => window.parallax),
    subscribe,
  } as Partial<ParallaxBridge> as ParallaxBridge;
  return {
    request,
    subscribe,
    unsubscribe,
    emit: (m: SubscriptionMessage) => act(() => listener(m)),
    connect: (state: ConnectionState) =>
      act(() => connections.forEach((connection) => connection("local", state))),
    traffic: (seq: number) => {
      listSeq = seq;
    },
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

/**
 * A bridge whose `watch` the test drives: `snapshot` and `emit` play plxd's side of the thread's
 * subscription (0059), and `orchestration/threadHistory` serves the sample's events before a
 * `seq`, two per page.
 */
function watchedBridge() {
  let listener: (m: WatchMessage) => void = () => {};
  const stop = vi.fn();
  const watch = vi.fn((_host: string, _params: WatchParams, l: (m: never) => void) => {
    listener = l as (m: WatchMessage) => void;
    return stop;
  });
  const request = vi.fn(async (_host: string, method: string, params: { before?: number }) => {
    if (method === "orchestration/threadRuns") return { result: { runs: [] }, logId: "log-1" };
    if (method !== "orchestration/threadHistory") return { result: {}, logId: "log-1" };
    const older = logged.filter((e) => e.seq < params.before!);
    return { result: { events: older.slice(-2), more: older.length > 2 }, logId: "log-1" };
  });
  const connections = new Set<(hostId: string, state: ConnectionState) => void>();
  window.parallax = {
    platform: "darwin",
    connectionState: async () => ({
      status: "connected",
      plxd: "0.1.0",
      protocol: 1,
      capabilities: {},
    }),
    onConnectionState: (l: (hostId: string, state: ConnectionState) => void) => {
      connections.add(l);
      return () => connections.delete(l);
    },
    request,
    watch,
  } as Partial<ParallaxBridge> as ParallaxBridge;
  const connect = (state: ConnectionState) =>
    act(() => connections.forEach((connection) => connection("local", state)));
  const snapshot = (
    events: LoggedEvent[],
    more = false,
    seq = events.at(-1)?.seq ?? 0,
    runs: ThreadRun[] = [],
  ) =>
    act(async () =>
      listener({
        type: "snapshot",
        snapshot: { seq, thread: sampleRun, runs, events, more, requests: [] },
      }),
    );
  const emit = (event: LoggedEvent) =>
    act(async () => listener({ type: "event", event: { subscription: "s", ...event } }));
  const emitError = (error: RpcError) => act(async () => listener({ type: "error", error }));
  return { watch, stop, request, snapshot, emit, emitError, connect };
}

test("opens from the thread's snapshot, appends its events, and a fresh snapshot rebuilds it", async () => {
  const { watch, stop, snapshot, emit } = watchedBridge();
  await renderChat();
  expect(watch).toHaveBeenCalledWith("local", { threadId: runId }, expect.any(Function));
  await snapshot(logged.slice(0, 2));
  expect(transcriptText()).toContain("Add a README");

  await emit(logged[2]!);
  // The agent's messages are never folded into a work dropdown.
  expect(transcriptText()).toContain("I'll add a README and note the build steps");

  // A reconnect whose gap was too long to replay starts over from plxd's new snapshot.
  await snapshot(logged.slice(0, 2), false, 50_000);
  expect(transcriptText()).not.toContain("I'll add a README and note the build steps");
  await emit({ ...logged[2]!, seq: 50_001 });
  expect(transcriptText()).toContain("I'll add a README and note the build steps");

  // Closed, it stays watched, so it opens again as it is now, without waiting on plxd.
  act(() => unmount());
  expect(stop).not.toHaveBeenCalled();
  await renderChat();
  expect(transcriptText()).toContain("I'll add a README and note the build steps");
  expect(watch).toHaveBeenCalledTimes(1);
});

test("the box keeps its focus as the transcript arrives under it (PLX-1051)", async () => {
  const { snapshot } = watchedBridge();
  await renderChat();
  expect(document.body.textContent).toContain("Loading…");
  const box = composer();
  act(() => box.focus());

  await snapshot(logged.slice(0, 2));
  expect(transcriptText()).toContain("Add a README");
  expect(composer()).toBe(box);
  expect(document.activeElement).toBe(box);
});

test("a thread's subscription that ended in an error opens again on the host's next connection", async () => {
  const { watch, emitError, snapshot, connect } = watchedBridge();
  await renderChat();
  await emitError({ code: -32000, message: "plxd's store failed" });
  expect(watch).toHaveBeenCalledOnce();
  const failed = { reason: "exited", message: "plxd exited" } as const;
  connect({ status: "failed", retrying: true, error: failed });
  connect({ status: "connected", plxd: "0.1.0", protocol: 1, capabilities: {} });
  await settle();
  expect(watch).toHaveBeenCalledTimes(2);
  await snapshot(logged.slice(0, 2));
  expect(transcriptText()).toContain("Add a README");
});

test.each(["live", "snapshot"] as const)(
  "a %s revert pages past the undone tail to the kept turn",
  async (mode) => {
    const turn = (seq: number, turnId: string, text: string): LoggedEvent => ({
      seq,
      time: "",
      event: {
        kind: "agent.output",
        runId,
        items: [{ kind: "turnStarted", turnId, text, wake: false, images: [], threads: [] }],
      },
    });
    const history: LoggedEvent[] = [
      turn(1, "kept", "Keep this message"),
      turn(2, "undone", "Undo this message"),
      ...Array.from({ length: 1100 }, (_, i): LoggedEvent => ({
        seq: i + 3,
        time: "",
        event: {
          kind: "agent.output",
          runId,
          items: [{ kind: "text", text: "Undone output" }],
        },
      })),
    ];
    const reverted: LoggedEvent = {
      seq: 1103,
      time: "",
      event: { kind: "thread.reverted", runId, ordinal: 1, turns: ["undone"], restoreFiles: false },
    };
    const { request, snapshot, emit } = watchedBridge();
    request.mockImplementation(async (_host, method, params) => {
      if (method === "orchestration/threadRuns") return { result: { runs: [] }, logId: "log-1" };
      if (method !== "orchestration/threadHistory") return { result: {}, logId: "log-1" };
      const older = history.filter((e) => e.seq < params.before!);
      return { result: { events: older.slice(-500), more: older.length > 500 }, logId: "log-1" };
    });
    await renderChat();
    if (mode === "snapshot") await snapshot([...history.slice(-499), reverted], true);
    else {
      await snapshot(history.slice(-500), true);
      await emit(reverted);
    }
    await settle();
    expect(transcriptText()).toContain("Keep this message");
    expect(transcriptText()).not.toContain("Undone output");
    expect(transcriptText()).not.toContain("Undo this message");
    expect(
      request.mock.calls.filter(([, method]) => method === "orchestration/threadHistory").length,
    ).toBeGreaterThanOrEqual(2);
  },
);

test("Enter sends with a fresh v7 turn id, but not while an IME is composing", async () => {
  const { request } = fakeBridge(4);
  await renderChat();
  const box = composer();
  type("Also mention the tests.");
  expect(document.querySelector('button[aria-label="Stop"]')).toBeNull();

  const dispatch = (event: Event) => act(async () => void box.dispatchEvent(event));
  const enter = (isComposing: boolean) =>
    dispatch(new KeyboardEvent("keydown", { key: "Enter", isComposing, bubbles: true }));
  // An IME taking the Enter that confirms its text.
  await dispatch(new CompositionEvent("compositionstart", { bubbles: true }));
  await enter(true);
  await dispatch(new CompositionEvent("compositionend", { bubbles: true }));
  expect(sendCalls(request).length > 0).toBe(false);

  await enter(false);
  const send = sendCalls(request)[0]!;
  expect(send[2]).toMatchObject({ runId, text: "Also mention the tests." });
  expect((send[2] as { turnId: string }).turnId).toMatch(/^[0-9a-f]{8}-[0-9a-f]{4}-7/);
  expect(box.textContent).toBe("");
  // Shown as pending until its turn starts.
  expect(transcriptText()).toContain("Also mention the tests.");
});

test("a dropped follow-up sent from here can be sent again, once", async () => {
  const { request, emit } = fakeBridge(4);
  await renderChat();
  const box = composer();
  type("Also mention the tests.");
  await act(async () => {
    box.dispatchEvent(new KeyboardEvent("keydown", { key: "Enter", bubbles: true }));
  });
  const sends = () => sendCalls(request);
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

test("Stop or Esc before the agent answers puts the prompt back in the box, but not after", async () => {
  const prompt = "Add a README that explains how to build the app.";
  const stopButton = () => document.querySelector<HTMLButtonElement>('button[aria-label="Stop"]')!;
  fakeBridge(2); // started, with nothing from the agent yet
  await renderChat();
  await act(async () => stopButton().click());
  expect(composer().textContent).toBe(prompt);
  act(() => unmount());

  fakeBridge(2);
  await renderChat();
  await act(
    async () =>
      void composer().dispatchEvent(new KeyboardEvent("keydown", { key: "Escape", bubbles: true })),
  );
  expect(composer().textContent).toBe(prompt);
  act(() => unmount());

  const { request } = fakeBridge(4); // the agent has replied
  await renderChat();
  await act(async () => stopButton().click());
  expect(request).toHaveBeenCalledWith("local", "orchestration/dispatch", {
    type: "run.interrupt",
    threadId: runId,
    holdQueue: true,
  });
  expect(composer().textContent).toBe("");
});

test("the box keeps what it holds across a visit to a subagent (PLX-887)", async () => {
  fakeBridge(4);
  const chat = (subagent?: string) => (
    <AgentChat hostId="local" runId={runId} subagent={subagent} />
  );
  const root = render(chat());
  await settle();
  act(() => void composer().editor!.commands.setContent("Half a thought"));
  await act(async () => root.render(chat("sub-1")));
  await act(async () => root.render(chat()));
  expect(composer().textContent).toBe("Half a thought");
});

test("an open thread's composer picks within its provider and sends only what changed", async () => {
  const onSend = vi.fn(async () => undefined);
  const open = (optionsDisabled?: string) =>
    render(
      <Composer
        backend="claude"
        started={{ model: "claude-opus-5-5", effort: "xhigh", permission: "plan" }}
        unavailable={{
          codex: "Codex is unavailable in this thread. Start a new thread to switch providers.",
        }}
        onSend={onSend}
        optionsDisabled={optionsDisabled}
      />,
    );
  const control = (label: string) => document.querySelector(`[aria-label="${label}"]`)!;
  // happy-dom doesn't disable a disabled fieldset's controls, which browsers do.
  const off = (label: string) => control(label).closest("fieldset")!.disabled;

  open("The model, effort, and access can change once it finishes");
  expect(off("Model: Claude Opus 5.5")).toBe(true);
  expect(off("Reasoning effort: Extra high")).toBe(true);
  expect(off("Access: Plan")).toBe(true);
  act(() => unmount());

  open();
  expect(off("Model: Claude Opus 5.5")).toBe(false);
  expect(off("Reasoning effort: Extra high")).toBe(false);
  expect(off("Access: Plan")).toBe(false);
  // The model menu lists only Claude's models; Codex is in the rail, disabled, saying why.
  const menu = document.getElementById(
    control("Model: Claude Opus 5.5").getAttribute("popovertarget")!,
  )!;
  const listed = [...menu.querySelectorAll<HTMLElement>('[role="menuitemradio"]')];
  expect(listed.every((m) => m.textContent?.includes("Claude"))).toBe(true);
  expect(menu.querySelector<HTMLButtonElement>('button[aria-label="Claude"]')!.disabled).toBe(
    false,
  );
  expect(menu.querySelector<HTMLButtonElement>('button[aria-label="Codex"]')!.disabled).toBe(true);

  await act(async () =>
    listed.find((m) => m.textContent?.startsWith("Claude Sonnet 5.5"))!.click(),
  );
  const set = (el: HTMLInputElement, value: string) =>
    act(() => {
      Object.getOwnPropertyDescriptor(Object.getPrototypeOf(el), "value")!.set!.call(el, value);
      el.dispatchEvent(new Event("input", { bubbles: true }));
    });
  set(document.querySelector<HTMLInputElement>('input[type="range"]')!, "0");
  type("Just the summary");
  await act(async () =>
    document.querySelector<HTMLButtonElement>('button[aria-label="Send"]')!.click(),
  );
  // Access is still the run's, so it isn't sent.
  expect(onSend).toHaveBeenCalledWith(
    "Just the summary",
    { model: "claude-sonnet-5-5", effort: "low" },
    [],
    [],
  );
});

test("an open thread's new Access goes to the running run at once", async () => {
  const onPermission = vi.fn();
  render(
    <Composer
      backend="claude"
      started={{ model: "claude-opus-5-5", effort: "xhigh", permission: "manual" }}
      onSend={async () => undefined}
      onPermission={onPermission}
    />,
  );
  const pick = async (label: string, option: string) => {
    const control = document.querySelector(`[aria-label="${label}"]`)!;
    const menu = document.getElementById(control.getAttribute("popovertarget")!)!;
    const item = [...menu.querySelectorAll<HTMLElement>('[role="menuitemradio"]')].find((m) =>
      m.textContent?.startsWith(option),
    )!;
    await act(async () => item.click());
  };
  await pick("Access: Supervised", "Supervised");
  expect(onPermission).not.toHaveBeenCalled();
  await pick("Access: Supervised", "Full access");
  expect(onPermission).toHaveBeenCalledExactlyOnceWith("bypass");
  // Back again before the run reports the switch: the run must hear it too.
  await pick("Access: Full access", "Supervised");
  expect(onPermission).toHaveBeenLastCalledWith("manual");
});

test("another provider's model moves an open thread there, with every option and the account", async () => {
  const onSend = vi.fn(async () => undefined);
  render(
    <Composer
      backend="claude"
      started={{ model: "claude-opus-5-5", effort: "xhigh", permission: "plan" }}
      onSend={onSend}
    />,
  );
  const control = (label: string) => document.querySelector(`[aria-label="${label}"]`);
  const menu = document.getElementById(
    control("Model: Claude Opus 5.5")!.getAttribute("popovertarget")!,
  )!;
  expect(menu.querySelector<HTMLButtonElement>('button[aria-label="Codex"]')!.disabled).toBe(false);
  act(() => menu.querySelector<HTMLButtonElement>('button[aria-label="Codex"]')!.click());
  const astra = [...menu.querySelectorAll<HTMLElement>('[role="menuitemradio"]')].find((m) =>
    m.textContent?.startsWith("GPT-6 Astra"),
  )!;
  await act(async () => astra.click());
  // Codex has no Plan, so Plan becomes Auto-accept edits.
  expect(control("Access: Plan")).toBeNull();
  type("Carry on");
  await act(async () =>
    document.querySelector<HTMLButtonElement>('button[aria-label="Send"]')!.click(),
  );
  expect(onSend).toHaveBeenCalledWith(
    "Carry on",
    {
      model: "gpt-6-astra",
      effort: "xhigh",
      permission: "edit",
      account: { kind: "subscription", backend: "codex" },
    },
    [],
    [],
  );
});

// The musing row: what stands for the agent's next step while nothing is in flight, a running
// "Working" line of its own rather than a fold's header.
const musingRow = () =>
  [...document.querySelectorAll('[role="log"] [data-index]')].find((r) =>
    [...r.querySelectorAll("[data-slot=trace-line][data-status=running]")].some(
      (line) => !line.closest("summary") && line.textContent === "Working",
    ),
  );

test("until its transcript loads, only a chat that just started shows its first message, with the loader", async () => {
  fakeBridge(8);
  // The transcript is still on its way.
  window.parallax.request = vi.fn(() => new Promise<never>(() => {}));
  render(<AgentChat hostId="local" runId={runId} prompt="Add a README" />);
  await settle();
  // Its first message alone would show as all the thread holds.
  expect(transcriptText()).toBe("");
  expect(document.body.textContent).toContain("Loading…");
  act(() => unmount());

  render(<AgentChat hostId="local" runId={runId} prompt="Add a README" going />);
  await settle();
  expect(document.querySelector('[role="log"] .bg-selected')!.textContent).toBe("Add a README");
  expect(musingRow()!.textContent).toBe("Working");
});

test("in a fork, only a turn that ended past the copied history offers Fork, at that turn", async () => {
  window.parallax = {
    connectionState: async () => ({ status: "connecting" as const }),
    onConnectionState: () => () => {},
  } as Partial<ParallaxBridge> as ParallaxBridge;
  const copiedAt = "2026-10-04T10:00:00.000Z";
  const rows: Item[] = [
    { kind: "user", key: "p", text: "Plan it", at: copiedAt },
    { kind: "tool", key: "t1", callId: "1", name: "Bash", status: "ok", at: copiedAt },
    { kind: "assistant", key: "a1", text: "Planned", at: copiedAt },
    { kind: "end", key: "e1", outcome: { status: "completed" }, at: copiedAt },
    { kind: "user", key: "f", text: "Build it", turnId: "turn-2", at: "2026-10-04T10:05:00Z" },
    { kind: "assistant", key: "a2", text: "Built", at: "2026-10-04T10:06:00Z" },
    { kind: "user", key: "g", text: "Ship it", turnId: "turn-3", at: "2026-10-04T10:07:00Z" },
  ];
  const onFork = vi.fn(async () => undefined);
  const run = { id: "fork", status: "running", backend: "claude" } as AgentRun;
  render(
    <ForkContext value={{ hostId: "local", run, onFork }}>
      <TranscriptView rows={rows} sent={new Map()} live copiedAt={copiedAt} />
    </ForkContext>,
  );

  const forks = () => [...document.querySelectorAll('button[aria-label="Fork from here"]')];
  // The prompt and the last reply of the turn that ended offer it, at that turn.
  expect(forks().map((b) => b.closest(".group\\/prompt")!.textContent)).toEqual([
    expect.stringContaining("Build it"),
    expect.stringContaining("Built"),
  ]);
  // Prompts and replies show when they were sent, but the copied ones' time is the fork's.
  expect(
    [...document.querySelectorAll("time")].map((t) => t.closest(".group\\/prompt")!.textContent),
  ).toEqual([
    expect.stringContaining("Build it"),
    expect.stringContaining("Built"),
    expect.stringContaining("Ship it"),
  ]);
  // happy-dom has no popovers: the Fork menus get the event a browser sends as one opens.
  act(() => {
    for (const menu of document.querySelectorAll('[role="menu"][aria-label="Fork"]'))
      menu.dispatchEvent(Object.assign(new Event("beforetoggle"), { newState: "open" }));
  });
  const keep = [...document.querySelectorAll<HTMLButtonElement>('[role="menuitem"]')].find((b) =>
    b.textContent?.startsWith("Keep"),
  )!;
  await act(async () => keep.click());
  expect(onFork).toHaveBeenCalledWith("turn-2", {});
});
test("scrolling up from the end, however little, stops following until it scrolls back down (PLX-1031)", () => {
  window.parallax = {
    connectionState: async () => ({ status: "connecting" as const }),
    onConnectionState: () => () => {},
  } as Partial<ParallaxBridge> as ParallaxBridge;
  const rows: Item[] = [
    { kind: "user", key: "p", text: "Explain it" },
    { kind: "assistant", key: "a1", text: "It works like this." },
  ];
  const root = render(<TranscriptView rows={rows} sent={new Map()} live={false} />);
  // happy-dom lays nothing out: the list's heights and position, as a browser would have them.
  const log = document.querySelector<HTMLElement>('[role="log"]')!;
  let height = 1000;
  let top = 0;
  Object.defineProperties(log, {
    scrollHeight: { get: () => height },
    clientHeight: { get: () => 300 },
    scrollTop: {
      get: () => top,
      set: (v: number) => {
        top = v;
      },
    },
  });
  const scroll = (deltaY: number, to: number) =>
    act(() => {
      log.dispatchEvent(new WheelEvent("wheel", { deltaY, bubbles: true }));
      top = to;
      log.dispatchEvent(new Event("scroll"));
    });
  // An update the list re-renders for, which grows it.
  const update = () => {
    height += 100;
    rows.push({ kind: "assistant", key: `a${rows.length}`, text: "More." });
    act(() => root.render(<TranscriptView rows={[...rows]} sent={new Map()} live={false} />));
  };

  scroll(5, 700);
  // A scroll up that a box in it takes, such as a tool's output, leaves it following.
  const box = log.appendChild(document.createElement("div"));
  box.style.overflowY = "auto";
  Object.defineProperties(box, {
    scrollHeight: { get: () => 400 },
    clientHeight: { get: () => 200 },
    scrollTop: { get: () => 100 },
  });
  act(() => {
    box.dispatchEvent(new WheelEvent("wheel", { deltaY: -5, bubbles: true }));
  });
  update();
  expect(top).toBe(height);
  scroll(5, height - 300);
  // 5px up from the end, an update leaves it where the user put it.
  scroll(-5, 695);
  update();
  expect(top).toBe(695);
  // Back down near the end, it follows again.
  scroll(5, height - 300 - 10);
  update();
  expect(top).toBe(height);
});
test("a tool named like an object's own property, or a status from a newer plxd, is read as any other", () => {
  const tool: Item = { kind: "tool", key: "t", callId: "1", name: "constructor", input: {} };
  render(<RowView row={tool} live open={false} onToggle={() => {}} />);
  expect(said()).toBe("Running");
  act(() => unmount());
  render(<RowView row={{ ...tool, status: "ok" }} live open={false} onToggle={() => {}} />);
  expect(said()).toBe("Succeeded");
  act(() => unmount());
  // A status from a newer plxd reads as no result, rather than breaking the row.
  row({ ...tool, status: "cancelled" as AgentToolStatus });
  expect(said()).toBe("No result");
});
test("a message a finished run couldn't take goes back in the box", async () => {
  const send = async (text: string) => {
    type(text);
    await act(async () => {
      composer().dispatchEvent(new KeyboardEvent("keydown", { key: "Enter", bubbles: true }));
    });
    await settle();
  };
  // plxd answers with the run its CLI failed to start again, and no turn follows.
  fakeBridge(8, { sent: { status: "failed", error: "the CLI didn't start" } });
  await renderChat();
  await send("Also mention the tests.");
  expect(composer().textContent).toBe("Also mention the tests.");
  expect(transcriptText()).not.toContain("Also mention the tests.");
});
