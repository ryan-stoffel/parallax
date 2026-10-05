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

// A thread's parent and children in the top bar and the sidebar (PLX-374, 0041).

Object.assign(globalThis, { IS_REACT_ACT_ENVIRONMENT: true });
// happy-dom has no popovers. The tree's rows are in the DOM either way.
HTMLElement.prototype.showPopover = () => {};
HTMLElement.prototype.hidePopover = () => {};
Object.defineProperty(HTMLElement.prototype, "offsetHeight", {
  get(this: HTMLElement) {
    return this.getAttribute("role") === "log" ? 10_000 : 20;
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
const nameThread = vi.fn<ParallaxBridge["nameThread"]>(async () => ({}));

beforeEach(() => {
  request.mockClear();
  localStorage.clear();
  capabilities = { threadLineage: {} };
  nameThread.mockReset().mockResolvedValue({});
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
        runs: p["project"] ? runs.filter((r) => r.project === p["project"]) : runs,
        seq: 7,
      },
    }),
    "project/list": () => ({ result: { projects: [], seq: 7 } }),
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
    subscribe: () => () => {},
    request,
    nameThread,
    hosts: async () => [],
    onHosts: () => () => {},
    onLocalName: (listener: (name: string) => void) => {
      listener("This Mac");
      return () => {};
    },
    setZoom: () => {},
    openTargets: async () => [],
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
const press = async (code: string) => {
  await act(async () => {
    window.dispatchEvent(new KeyboardEvent("keydown", { code, metaKey: true, altKey: true }));
  });
  await settle();
};
const calls = (method: string) =>
  request.mock.calls.filter(([, m]) => m === method).map(([, , params]) => params);

// The breadcrumb's crumbs, without the trail, and which one is the current page.
const crumbItems = () =>
  [...document.querySelectorAll('[aria-label="Breadcrumb"] li')].filter(
    (li) => !li.querySelector('[role="group"]'),
  );
const crumbs = () => crumbItems().map((li) => li.textContent);
const currentCrumb = () =>
  crumbItems().find((li) => li.querySelector('[aria-current="page"]'))?.textContent;
const crumb = (label: string) =>
  [...document.querySelectorAll<HTMLButtonElement>('[aria-label="Breadcrumb"] li > button')].find(
    (b) => b.textContent === label,
  );
const chipGroup = () => document.querySelector('[aria-label="Breadcrumb"] [role="group"]');
// Each chip's title, the open one starred.
const chips = () =>
  [...(chipGroup()?.querySelectorAll(":scope > button:not([popovertarget])") ?? [])].map(
    (b) => `${b.textContent}${b.getAttribute("aria-current") ? "*" : ""}`,
  );
const chip = (title: string) =>
  [...(chipGroup()?.querySelectorAll(":scope > button") ?? [])].find(
    (b) => b.textContent === title,
  );
// A sidebar group's toggle, by its count.
const toggle = (count: string) =>
  [...document.querySelectorAll("#sidebar button[aria-expanded]")].find((b) =>
    b.textContent?.startsWith(count),
  );
const sidebarRow = (title: string) =>
  [...document.querySelectorAll('#sidebar li[data-kind="thread"] > button:first-child')].find(
    (b) => b.querySelector("[data-title]")?.textContent === title,
  );
const sidebarTitles = () =>
  [...document.querySelectorAll('#sidebar li[data-kind="thread"] [data-title]')].map(
    (t) => t.textContent,
  );

test("a thread with no parent or children has today's breadcrumb and no chips", async () => {
  await renderApp();
  await click(sidebarRow("Fix the README"));
  expect(crumbs()).toEqual(["This Mac", "parallax", "Fix the README"]);
  expect(currentCrumb()).toBe("Fix the README");
  expect(chipGroup()).toBeNull();
});

test("a parent's chips open its children, and a child's parent crumb opens the parent", async () => {
  await renderApp();
  await click(sidebarRow("Ship lineage"));
  expect(crumbs()).toEqual(["This Mac", "parallax", "Ship lineage"]);
  expect(currentCrumb()).toBe("Ship lineage");
  expect(chipGroup()!.getAttribute("aria-label")).toBe("Child threads");
  expect(chips()).toEqual(["Style the chips", "Write the test"]);
  // Each chip's tooltip says what it's doing.
  expect(chip("Write the test")!.getAttribute("title")).toBe("Write the test · Failed");

  await click(chip("Write the test"));
  expect(document.querySelector('main section[aria-label="Child thread"]')!.textContent).toBe(
    "A child thread of Ship lineageOpen parent⌥⌘↑",
  );
  expect(crumbs()).toEqual(["This Mac", "parallax", "Ship lineage"]);
  expect(chipGroup()!.getAttribute("aria-label")).toBe("Sibling threads");
  expect(chips()).toEqual(["Style the chips", "Write the test*"]);
  // The parent's crumb is a way back, not the page.
  expect(currentCrumb()).toBeUndefined();

  await click(crumb("Ship lineage"));
  expect(currentCrumb()).toBe("Ship lineage");
  expect(chips()).toEqual(["Style the chips", "Write the test"]);
});

test("past four children, the open one stays among the chips, and +N lists the whole tree", async () => {
  threads.push(
    ...["c", "d", "e", "f"].map((id, i) => thread(id, 10 + i, { parent: "parent", title: id })),
    thread("grandchild", 20, { parent: "f", title: "grandchild" }),
  );
  runs.push(...["c", "d", "e", "f", "grandchild"].map((id) => run(id, "completed")));
  await renderApp();
  await click(sidebarRow("Ship lineage"));
  expect(chips()).toEqual(["Style the chips", "Write the test", "c", "d"]);
  const more = chipGroup()!.querySelector("button[popovertarget]")!;
  expect(more.textContent).toBe("+2");

  // The tree, from the top: each title, then its model, status, and when it was last active.
  const tree = document.querySelector('[role="dialog"][aria-label="Thread tree"]')!;
  const rows = [...tree.querySelectorAll("li > button")];
  expect(rows.map((r) => r.querySelector(".truncate")!.textContent)).toEqual([
    "Ship lineage",
    "Style the chips",
    "Write the test",
    "c",
    "d",
    "e",
    "f",
    "grandchild",
  ]);
  expect(rows[2]!.textContent).toContain("Claude Sonnet 5 · Failed");
  expect(rows[0]!.getAttribute("aria-current")).toBe("page");

  // A row opens its thread; the fifth child swaps into the last chip's place.
  await click(rows[5]);
  expect(chips()).toEqual(["Style the chips", "Write the test", "c", "e*"]);
  expect(chipGroup()!.querySelector("button[popovertarget]")!.textContent).toBe("+2");
});

test("Mod+Alt+Up goes to the parent, and Mod+Alt+Right and Left cycle through the children", async () => {
  await renderApp();
  await click(sidebarRow("Ship lineage"));
  await press("ArrowRight");
  expect(chips()).toEqual(["Style the chips*", "Write the test"]);
  await press("ArrowRight");
  expect(chips()).toEqual(["Style the chips", "Write the test*"]);
  await press("ArrowRight");
  expect(chips()).toEqual(["Style the chips*", "Write the test"]);
  await press("ArrowLeft");
  expect(chips()).toEqual(["Style the chips", "Write the test*"]);
  await press("ArrowUp");
  expect(currentCrumb()).toBe("Ship lineage");
  // From the parent, Left opens the last child.
  await press("ArrowLeft");
  expect(chips()).toEqual(["Style the chips", "Write the test*"]);
});

test("the sidebar nests children under their parent, collapsed, with a count and the most urgent status", async () => {
  await renderApp();
  expect(sidebarTitles()).toEqual(["Fix the README", "Ship lineage"]);
  const group = toggle("2 threads")!;
  expect(group.getAttribute("aria-expanded")).toBe("false");
  // Failed outranks Working.
  expect(group.textContent).toBe("2 threadsFailed");

  await click(group);
  expect(sidebarTitles()).toEqual([
    "Fix the README",
    "Ship lineage",
    "Style the chips",
    "Write the test",
  ]);
  await click(group);
  expect(sidebarTitles()).toEqual(["Fix the README", "Ship lineage"]);

  // Opening a child, here from its parent's chips, opens its group.
  await click(sidebarRow("Ship lineage"));
  await click(chip("Style the chips"));
  expect(group.getAttribute("aria-expanded")).toBe("true");
  expect(sidebarRow("Style the chips")!.getAttribute("aria-current")).toBe("page");
});

test("a Project's children never show in the main sidebar, and its row shows their status (0042)", async () => {
  const coordinator = {
    ...run("coord", "completed"),
    project: "p-ember",
    policy: "noWrite" as const,
  };
  threads = [
    ...threads,
    thread("kid", 4, { parent: "coord", title: "Write the docs" }),
    thread("grandkid", 5, { parent: "kid", title: "Check the links" }),
  ];
  const child = (id: string, status?: string) => ({ ...run(id, status), accountId: "claude" });
  runs = [...runs, coordinator, child("kid", "completed"), child("grandkid")];
  answers["project/list"] = () => ({
    result: {
      projects: [
        {
          id: "p-ember",
          name: "ember",
          repoPath: parallax.path,
          coordinator: "coord",
          createdAt: "2026-10-01T09:00:00Z",
          updatedAt: "2026-10-01T09:00:00Z",
        },
      ],
      seq: 7,
    },
  });
  await renderApp();
  await click(toggle("2 threads"));
  expect(sidebarTitles()).toEqual([
    "Fix the README",
    "Ship lineage",
    "Style the chips",
    "Write the test",
  ]);
  const ember = document.querySelector('#sidebar li[data-kind="project"]');
  expect(ember?.querySelector("[data-status]")?.textContent).toBe("Working");

  // `agent/list {project}` has only the coordinator, so its Project tab lists the threads in it.
  await click(ember?.querySelector("button"));
  const titles = (group: string) =>
    [...document.querySelectorAll(`#side-panel section[aria-label="${group}"] li > button`)].map(
      (b) => b.querySelector("span span")?.textContent,
    );
  expect(titles("Working")).toEqual(["Check the links"]);
  await click(document.querySelector('#side-panel section[aria-label="Resolved"] h3 button'));
  expect(titles("Resolved")).toEqual(["Write the docs"]);
  // With nothing reported, a finished child says Done, as a thread does.
  expect(
    document.querySelector('#side-panel section[aria-label="Resolved"] li > button')!.textContent,
  ).toContain("Done");
});

test("without threadLineage, children aren't nested and there are no chips", async () => {
  capabilities = {};
  await renderApp();
  await click(sidebarRow("Ship lineage"));
  expect(chipGroup()).toBeNull();
  expect(toggle("2 threads")).toBeUndefined();
});

test("titles come from plxd: a new thread sends its generated title, and a title kept here moves there once", async () => {
  threads = [thread("old", 0)];
  runs = [run("old")];
  localStorage.setItem("parallax:title:old", "Kept title");
  answers["thread/update"] = (p) => ({
    result: { thread: { ...thread("old", 0), title: p["title"] } },
  });
  nameThread.mockResolvedValue({ title: "Fix flaky test", slug: "fix-flaky-test" });
  answers["thread/start"] = (p) => ({
    result: {
      thread: { ...thread(p["runId"] as string, 30), title: p["title"] },
      run: run(p["runId"] as string),
    },
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
    expect.objectContaining({ title: "Fix flaky test", branchSlug: "fix-flaky-test" }),
  ]);
  expect(Object.keys(localStorage).filter((k) => k.startsWith("parallax:title:"))).toEqual([]);
  expect(crumbs()).toEqual(["This Mac", "parallax", "Fix flaky test"]);
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

test("an agent's own subagents are read-only chips after its children, and one opens without a composer", async () => {
  answers["agent/events"] = (params) => ({
    result: {
      events: params["runId"] === "parent" && params["after"] === 0 ? parentLog() : [],
      more: false,
    },
  });
  await renderApp();
  await click(sidebarRow("Ship lineage"));
  expect(chips()).toEqual(["Style the chips", "Write the test", "Read the docs", "Read the tests"]);
  const docs = chip("Read the docs")!;
  expect(docs.getAttribute("aria-label")).toBe("Read the docs, read-only subagent, Done");
  expect(chip("Read the tests")!.getAttribute("title")).toBe(
    "Read the tests · Working · Read-only subagent",
  );
  // The parent's own transcript has the calls, not what the subagents did.
  const log = () => document.querySelector('[role="log"]')!;
  await click(log().querySelector("button[aria-expanded]"));
  expect(log().textContent).not.toContain("README.md");
  const row = log().querySelector('button[aria-label="Open subagent: Read the tests, Working"]');
  expect(row).not.toBeNull();

  await click(docs);
  expect(crumbs()).toEqual(["This Mac", "parallax", "Ship lineage", "Read the docs"]);
  expect(chips()).toContain("Read the docs*");
  expect(log().textContent).toContain("Read the docs.");
  expect(log().textContent).toContain("The docs say pnpm.");
  expect(document.querySelector('[role="status"][aria-label="Subagent"]')!.textContent).toBe(
    "Explore · Claude Haiku 4.5 · DoneRead-only: Claude Code's own subagent",
  );
  expect(document.querySelector('[role="textbox"][aria-label="Message"]')).toBeNull();

  // Its thread's crumb goes back, and the call's row opens the other one.
  await click(crumb("Ship lineage"));
  expect(document.querySelector('[role="textbox"][aria-label="Message"]')).not.toBeNull();
  await click(log().querySelector("button[aria-expanded]"));
  await click(log().querySelector('button[aria-label="Open subagent: Read the tests, Working"]'));
  expect(crumbs().at(-1)).toBe("Read the tests");
});
