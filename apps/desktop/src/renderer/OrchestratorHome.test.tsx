// @vitest-environment happy-dom
import { act } from "react";
import { createRoot } from "react-dom/client";
import { afterEach, expect, test, vi } from "vite-plus/test";

import type { ParallaxBridge, SubscriptionMessage } from "../preload/bridge";
import type {
  AgentRun,
  ContextFile,
  InboxItem,
  Orchestrator,
} from "../protocol/generated/protocol";
import { useOrchestratorContext } from "./ContextPanel";
import { headline, OrchestratorHome } from "./OrchestratorHome";

Object.assign(globalThis, { IS_REACT_ACT_ENVIRONMENT: true });

const at = "2026-10-04T12:00:00Z";
const file = (path: string, modifiedAt = at): ContextFile => ({ path, size: 10, modifiedAt });
const run = (id: string, more: Partial<AgentRun> = {}): AgentRun =>
  ({
    id,
    project: "o-1",
    prompt: id,
    policy: "workspaceWrite",
    status: "completed",
    backend: "claude",
    accountId: "a-1",
    createdAt: at,
    updatedAt: at,
    ...more,
  }) as AgentRun;
const item = (id: string, runId: string, kind: InboxItem["kind"], text: string): InboxItem =>
  ({ id, run: runId, kind, text, createdAt: at }) as InboxItem;

let unmount = () => {};
afterEach(() => act(() => unmount()));

async function render(node: React.ReactNode) {
  const root = createRoot(document.body.appendChild(document.createElement("div")));
  act(() => root.render(node));
  unmount = () => {
    root.unmount();
    document.body.innerHTML = "";
  };
  for (let i = 0; i < 10; i++) await act(async () => {});
}

test("the context files follow the orchestrator's own events", async () => {
  let listener: (message: SubscriptionMessage) => void = () => {};
  const subscribe = vi.fn<ParallaxBridge["subscribe"]>((_host, _params, heard) => {
    listener = heard;
    return () => {};
  });
  window.parallax = {
    request: async (_host: string, method: string) =>
      method === "agent/list"
        ? { logId: "log-1", result: { runs: [], seq: 7 } }
        : { logId: "log-1", result: { files: [file("notes.md")] } },
    subscribe,
    connectionState: async () => ({ status: "connected", plxd: "", protocol: 1, capabilities: {} }),
    onConnectionState: () => () => {},
  } as Partial<ParallaxBridge> as ParallaxBridge;
  function Files() {
    const { files, error } = useOrchestratorContext("local", "o-1", true);
    return <p>{error ?? files.map((f) => `${f.path} ${f.modifiedAt}`).join(", ")}</p>;
  }
  await render(<Files />);

  // plxd refuses `shell` without `project` (PLX-1340).
  expect(subscribe.mock.calls[0]?.[1]).toEqual({
    after: 7,
    project: "o-1",
    shell: true,
    logId: "log-1",
  });
  const later = "2026-10-04T12:05:00Z";
  act(() =>
    listener({
      type: "event",
      event: {
        subscription: "s-1",
        seq: 8,
        time: later,
        project: "o-1",
        event: { kind: "context.changed", file: file("notes.md", later) },
      },
    } as SubscriptionMessage),
  );
  expect(document.body.textContent).toBe(`notes.md ${later}`);
});

test("the tab lists each child under what the user does about it", async () => {
  const orchestrator = { id: "o-1", name: "ember", repoPath: "/repo", run: "k" } as Orchestrator;
  const runs = [
    run("k"),
    run("asks", { status: "running" }),
    // Its newest inbox item is from the turn before this one.
    run("works", { status: "running", branch: "parallax/works" }),
    run("broke", { status: "failed" }),
    run("unread", { diff: { commit: "c", files: 2, insertions: 96, deletions: 12 } }),
    run("read"),
  ];
  const seen = vi.fn(async () => {});
  const onOpen = vi.fn();
  await render(
    <OrchestratorHome
      hostId="local"
      context={{ files: [] }}
      orchestrator={orchestrator}
      agents={{ runs, waiting: {}, start: async () => undefined }}
      inbox={{
        items: [
          item("i-1", "asks", "needsYou", "asks: Which one?"),
          { ...item("i-2", "works", "done", "works: finished the first pass"), seenAt: at },
          item("i-3", "broke", "failed", "broke: tests failed"),
          item("i-4", "unread", "done", "unread: done"),
          { ...item("i-5", "read", "done", "read: done"), seenAt: at },
        ],
        questions: [],
        seen,
        answer: async () => undefined,
      }}
      answerable={false}
      onOpen={onOpen}
    />,
  );

  const section = (label: string) =>
    document.querySelector(`section[aria-label="${label}"]`)?.textContent;
  expect(document.querySelector("h2")?.textContent).toBe("2 threads need you");
  expect(section("Needs you")).toContain("asks");
  expect(section("Needs you")).toContain("tests failed");
  expect(section("Working")).toContain("parallax/works");
  expect(section("Working")).not.toContain("finished the first pass");
  expect(section("To review")).toContain("+96 −12");
  expect(section("Earlier")).toContain("read");

  // Opening a finish marks what it reported read.
  const unread = [...document.querySelectorAll("button")].find((b) =>
    b.textContent?.startsWith("unread"),
  );
  act(() => unread!.click());
  expect(onOpen).toHaveBeenCalledWith("unread");
  expect(seen).toHaveBeenCalledWith(["i-4"]);
});

test("the headline leads with the most pressing open state", () => {
  const rows = (...groups: Parameters<typeof headline>[0][number]["group"][]) =>
    groups.map((group) => ({ group }));
  expect(headline(rows("working", "waiting", "ready", "ready"))).toEqual({
    lead: "1 thread needs you",
    rest: "1 working, 2 to review",
  });
  expect(headline(rows("working", "working"))).toEqual({ lead: "2 threads working" });
  expect(headline(rows("resolved")).lead).toBe("Nothing open");
  expect(headline([]).lead).toBe("No threads yet");
});
