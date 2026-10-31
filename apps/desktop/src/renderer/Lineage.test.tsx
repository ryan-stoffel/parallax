// @vitest-environment happy-dom
import type { TiptapEditorHTMLElement } from "@tiptap/react";
import { act } from "react";
import { createRoot } from "react-dom/client";
import { afterEach, beforeEach, expect, test, vi } from "vite-plus/test";

import type { RpcResponse, ParallaxBridge } from "../preload/bridge";
import type {
  AgentOutputItem,
  AgentRun,
  Capabilities,
  LoggedEvent,
  Repo,
  Thread,
} from "../protocol/generated/protocol";
import { App } from "./App";
import { fakeWatch } from "./fakeWatch";
import { sectionsStore } from "./Sidebar";

// A thread's lineage in the app (PLX-374, 0041): titles from plxd, and an agent's own subagents.

Object.assign(globalThis, { IS_REACT_ACT_ENVIRONMENT: true });
// happy-dom has no popovers. The tree's rows are in the DOM either way.
HTMLElement.prototype.showPopover = () => {};
HTMLElement.prototype.hidePopover = () => {};
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

const parallax: Repo = {
  id: "r-parallax",
  name: "parallax",
  path: "/src/parallax",
  createdAt: "2026-10-01T09:00:00Z",
};
// Created a minute apart, in this order.
const thread = (id: string, minute: number, extra: Partial<Thread> = {}): Thread => ({
  id,
  repo: parallax.id,
  createdAt: `2026-10-01T10:${String(minute).padStart(2, "0")}:00Z`,
  seenAt: "2026-10-01T12:00:00Z",
  ...extra,
});
const run = (id: string, status = "running", backend = "claude"): AgentRun =>
  ({
    id,
    prompt: `${id} prompt`,
    status,
    backend,
    model: "claude-sonnet-5",
    createdAt: "2026-10-01T10:00:00Z",
    updatedAt: "2026-10-01T11:00:00Z",
  }) as AgentRun;

let threads: Thread[];
let runs: AgentRun[];
let capabilities: Capabilities;
type Answer = (params: Record<string, unknown>) => RpcResponse<unknown>;
let answers: Record<string, Answer>;
const request = vi.fn(async (_host: string, method: string, params: Record<string, unknown>) => {
  const answer = answers[method];
  return answer
    ? { logId: "log-1", ...answer(params) }
    : { error: { code: -32601, message: `${method} isn't faked` } };
});

beforeEach(() => {
  request.mockClear();
  localStorage.clear();
  // Working starts folded (0075); these tests read the rows in it.
  sectionsStore.set({ all: { working: true } });
  capabilities = { threadLineage: {} };
  threads = [
    thread("parent", 0, { title: "Ship lineage" }),
    thread("a", 1, { parent: "parent", title: "Style the chips" }),
    // Never seen, so it failed since the user last looked.
    thread("b", 2, { parent: "parent", title: "Write the test", seenAt: undefined }),
    thread("solo", 3, { title: "Fix the README" }),
  ];
  runs = [run("parent"), run("a"), run("b", "failed", "codex"), run("solo", "completed")];
  answers = {
    "thread/list": () => ({ result: { repos: [parallax], threads, seq: 7 } }),
    "agent/list": (p) => ({
      result: {
        runs: p["orchestrator"] ? runs.filter((r) => r.project === p["orchestrator"]) : runs,
        seq: 7,
      },
    }),
    "orchestrator/list": () => ({ result: { orchestrators: [], seq: 7 } }),
  };
  window.parallax = {
    onProfile: () => () => {},
    platform: "darwin",
    setThemeSource: vi.fn(),
    connectionState: async () => ({
      status: "connected",
      plxd: "0.1.0",
      protocol: 1,
      capabilities,
    }),
    onConnectionState: () => () => {},
    onHostUpdate: () => () => {},
    watch: fakeWatch(() => window.parallax),
    subscribe: () => () => {},
    request,
    hosts: async () => [],
    onHosts: () => () => {},
    onConnect: () => () => {},
    onDevices: () => () => {},
    onAccessRequests: () => () => {},
    onLocalName: (listener: (name: string) => void) => {
      listener("This Mac");
      return () => {};
    },
    setZoom: () => {},
    openTargets: async () => [],
    terminalApps: async () => [],
    terminalApp: async () => null,
    openTargetIcons: async () => ({}),
  } as Partial<ParallaxBridge> as ParallaxBridge;
});

let unmount = () => {};
afterEach(() => act(() => unmount()));

async function renderApp() {
  const root = createRoot(document.body.appendChild(document.createElement("div")));
  act(() => root.render(<App />));
  unmount = () => {
    root.unmount();
    document.body.innerHTML = "";
  };
  await settle();
}
const settle = async () => {
  for (let i = 0; i < 10; i++) await act(async () => {});
};
const click = async (element: Element | null | undefined) => {
  await act(async () => (element as HTMLElement).click());
  await settle();
};
const calls = (method: string) =>
  request.mock.calls.filter(([, m]) => m === method).map(([, , params]) => params);

const crumb = (label: string) =>
  [...document.querySelectorAll<HTMLButtonElement>('[aria-label="Breadcrumb"] li > button')].find(
    (b) => b.textContent === label,
  );
const chipGroup = () => {
  const section = document.querySelector('[aria-label="Lineage"]');
  return section && section.querySelector("[data-lineage-title]") ? section : null;
};
const chip = (title: string) =>
  [...(chipGroup()?.querySelectorAll("li > button") ?? [])].find(
    (button) => button.querySelector("[data-lineage-title]")?.textContent === title,
  );
// Lineage's collapsed section of finished children, and opening it.
const previousToggle = () =>
  [...document.querySelectorAll('[aria-label="Lineage"] button[aria-expanded]')].find((b) =>
    b.textContent?.startsWith("Previous agents"),
  );
const openPrevious = async () => {
  const toggle = previousToggle();
  if (toggle?.getAttribute("aria-expanded") === "false") await click(toggle);
};
const sidebarRow = (title: string) =>
  [...document.querySelectorAll('#sidebar li[data-kind="thread"] > button:first-child')].find(
    (b) => b.querySelector("[data-title]")?.textContent === title,
  );
const sidebarTitles = () =>
  [...document.querySelectorAll('#sidebar li[data-kind="thread"] [data-title]')].map(
    (t) => t.textContent,
  );

test("titles come from plxd: a new thread asks plxd to name it, and a title kept here moves there once", async () => {
  capabilities = { threadLineage: {}, threadNaming: {} };
  threads = [thread("old", 0)];
  runs = [run("old")];
  localStorage.setItem("parallax:title:old", "Kept title");
  answers["thread/update"] = (p) => ({
    result: { thread: { ...thread("old", 0), title: p["title"] } },
  });
  answers["thread/start"] = (p) => ({
    result: { thread: thread(p["runId"] as string, 30), run: run(p["runId"] as string) },
  });
  await renderApp();
  expect(calls("thread/update")).toEqual([{ runId: "old", title: "Kept title" }]);
  expect(localStorage.getItem("parallax:title:old")).toBeNull();
  expect(sidebarTitles()).toEqual(["Kept title"]);

  const box = document.querySelector<TiptapEditorHTMLElement>(
    'main [role="textbox"][aria-label="Message"]',
  )!;
  act(() => void box.editor!.commands.setContent("the flaky test is flaky"));
  await act(async () => {
    box.dispatchEvent(new KeyboardEvent("keydown", { key: "Enter", bubbles: true }));
  });
  await settle();
  expect(calls("thread/start")).toEqual([
    expect.objectContaining({
      branchSlug: "the-flaky-test-is",
      naming: { backend: "codex", model: "gpt-6-luna", effort: "low" },
    }),
  ]);
  expect(calls("thread/start")[0]).not.toHaveProperty("title");
  expect(Object.keys(localStorage).filter((k) => k.startsWith("parallax:title:"))).toEqual([]);
});

// The parent's agent's own subagents (PLX-382): two of Claude Code's Agent calls, one done.
const agentCall = (callId: string, description: string): AgentOutputItem => ({
  kind: "toolCall",
  callId,
  name: "Agent",
  input: { description, prompt: `${description}.`, subagent_type: "Explore", model: "haiku" },
});
const parentLog = (): LoggedEvent[] => [
  {
    seq: 1,
    time: "2026-10-01T10:00:00Z",
    event: { kind: "agent.started", runId: "parent", run: run("parent") },
  },
  {
    seq: 2,
    time: "2026-10-01T10:00:05Z",
    event: {
      kind: "agent.output",
      runId: "parent",
      items: [
        agentCall("toolu_a", "Read the docs"),
        agentCall("toolu_b", "Read the tests"),
        {
          kind: "subagent",
          callId: "toolu_a",
          agentType: "Explore",
          model: "claude-haiku-4-5-20251001",
          item: {
            kind: "toolCall",
            callId: "toolu_r",
            name: "Read",
            input: { file_path: "README.md" },
          },
        },
        {
          kind: "subagentFinished",
          callId: "toolu_a",
          status: "completed",
          summary: "The docs say pnpm.",
        },
      ],
    },
  },
];

test("an agent's own subagents are read-only: the parent's transcript has the calls, and one opens without a composer", async () => {
  answers["agent/events"] = (params) => ({
    result: {
      events: params["runId"] === "parent" && params["after"] === 0 ? parentLog() : [],
      more: false,
    },
  });
  await renderApp();
  await click(sidebarRow("Ship lineage"));
  // The parent's own transcript has the calls, not what the subagents did.
  const log = () => document.querySelector('[role="log"]')!;
  await click(log().querySelector("summary"));
  expect(log().textContent).not.toContain("README.md");

  await openPrevious();
  await click(chip("Read the docs"));
  expect(log().textContent).toContain("Read the docs.");
  expect(log().textContent).toContain("The docs say pnpm.");
  expect(document.querySelector('[role="textbox"][aria-label="Message"]')).toBeNull();
  // Its thread's crumb goes back, to the parent's composer.
  await click(crumb("Ship lineage"));
  expect(document.querySelector('[role="textbox"][aria-label="Message"]')).not.toBeNull();
});
