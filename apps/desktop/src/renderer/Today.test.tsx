// @vitest-environment happy-dom
import { act } from "react";
import { createRoot } from "react-dom/client";
import { afterEach, beforeEach, expect, test, vi } from "vite-plus/test";

import samples from "../../../../crates/parallax-protocol/samples/v1/pull-requests.json";
import type { RpcResponse, ParallaxBridge } from "../preload/bridge";
import type {
  AgentRun,
  Capabilities,
  PullRequest,
  Repo,
  Thread,
} from "../protocol/generated/protocol";
import { App } from "./App";
import { fakeWatch } from "./fakeWatch";
import { autoClear } from "./pins";
import { resumeTime } from "./ResumeCard";
import { flushToasts } from "./undo";

// Today's Clear, auto-archive, and keys (0075).

Object.assign(globalThis, { IS_REACT_ACT_ENVIRONMENT: true });
HTMLElement.prototype.showPopover = () => {};
HTMLElement.prototype.hidePopover = () => {};

const samplePr = (samples as { id?: number; result?: PullRequest }[]).find(
  (m) => m.id === 2 && m.result,
)!.result!;
const parallax: Repo = {
  id: "r-parallax",
  name: "parallax",
  path: "/src/parallax",
  createdAt: "2026-10-01T09:00:00Z",
};
const ago = (minutes: number) => new Date(Date.now() - minutes * 60_000).toISOString();
// Prompted `minutes` ago and seen since.
const thread = (id: string, minutes: number, extra: Partial<Thread> = {}): Thread => ({
  id,
  repo: parallax.id,
  title: id,
  createdAt: ago(minutes),
  seenAt: ago(0),
  ...extra,
});
const run = (id: string, status: string, updated: number) =>
  ({
    id,
    prompt: id,
    status,
    backend: "claude",
    model: "claude-sonnet-5",
    createdAt: ago(updated),
    updatedAt: ago(updated),
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
const archiving =
  (refuse?: string): Answer =>
  (p) =>
    p["runId"] === refuse
      ? { error: { code: -32000, message: `${refuse} is busy` } }
      : {
          result: {
            thread: { ...threads.find((t) => t.id === p["runId"]), archived: p["archived"] },
          },
        };

beforeEach(() => {
  request.mockClear();
  localStorage.clear();
  autoClear.set(null);
  capabilities = {};
  answers = {
    "thread/list": () => ({ result: { repos: [parallax], threads, seq: 7 } }),
    "agent/list": () => ({ result: { runs, seq: 7 } }),
    "orchestrator/list": () => ({ result: { orchestrators: [], seq: 7 } }),
    "thread/archive": archiving(),
    "thread/update": (p) => ({
      result: { thread: { ...threads.find((t) => t.id === p["runId"]), ...p } },
    }),
  };
  window.parallax = {
    onProfile: () => () => {},
    onConnectNotice: () => () => {},
    onRelayUsage: () => () => {},
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
afterEach(() => {
  // The app keeps its notifications between tests, so close this test's.
  for (const close of document.querySelectorAll<HTMLButtonElement>(
    '[aria-label="Notifications"] [aria-label="Close"]',
  ))
    act(() => close.click());
  act(() => unmount());
  flushToasts();
});

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
const archived = () =>
  request.mock.calls
    .filter(([, m, p]) => m === "thread/archive" && p["archived"])
    .map(([, , p]) => p["runId"]);
const waitForArchives = (n: number) =>
  act(() => vi.waitFor(() => expect(archived()).toHaveLength(n), { timeout: 3000 }));
const button = (text: string) =>
  [...document.querySelectorAll<HTMLElement>("button")].find((b) => b.textContent === text);

test("auto-archive waits for quiet since the last prompt or run, skips usage limits, and an Undo sticks", async () => {
  autoClear.set(1);
  threads = [thread("quiet", 180), thread("ran-late", 180), thread("on-limit", 180)];
  runs = [
    run("quiet", "completed", 180),
    // Prompted hours ago, but it ran until minutes ago.
    run("ran-late", "completed", 10),
    run("on-limit", "waiting", 180),
  ];
  await renderApp();
  await waitForArchives(1);
  expect(archived()).toEqual(["quiet"]);
  expect(document.body.textContent).toContain("Archived 1 thread quiet for over 1 hours");

  await act(async () => button("Undo")!.click());
  // Back from Settings, say, the list mounts again; what was undone stays.
  act(() => unmount());
  await renderApp();
  expect(archived()).toEqual(["quiet"]);
});

test("auto-archive leaves a thread one it started is still working for, or waiting out a usage limit", async () => {
  autoClear.set(1);
  threads = [
    thread("lead", 200),
    thread("helper", 190, { parent: "lead" }),
    thread("paused", 195),
    thread("limited", 185, { parent: "paused" }),
    thread("plain", 180),
  ];
  runs = [
    run("lead", "completed", 200),
    run("helper", "running", 190),
    run("paused", "completed", 195),
    run("limited", "waiting", 185),
    run("plain", "completed", 180),
  ];
  await renderApp();
  await waitForArchives(1);
  await settle();
  expect(archived()).toEqual(["plain"]);
});

// Drags thread row `id` onto `target`, as the sidebar's rows drag (PLX-1095).
const dragRow = async (id: string, target: () => Element) => {
  const data = new DataTransfer();
  // happy-dom's DragEvent takes no dataTransfer.
  const event = (type: string) =>
    Object.defineProperty(new Event(type, { bubbles: true }), "dataTransfer", { value: data });
  const row = document.querySelector(`[data-row="local/${id}"]`)!;
  act(() => void row.dispatchEvent(event("dragstart")));
  act(() => {
    target().dispatchEvent(event("dragover"));
    target().dispatchEvent(event("drop"));
  });
  act(() => void row.dispatchEvent(event("dragend")));
  await settle();
};
const drawer = (label: string) =>
  [...document.querySelectorAll("details")].find((d) =>
    d.querySelector("summary")?.textContent?.startsWith(label),
  )!;
const list = () => document.querySelector('[aria-label="Threads"]')!.parentElement!;

test("a snoozed row shows when it wakes, and an archived one its age (PLX-1308)", async () => {
  capabilities = { threadAttention: {} } as Capabilities;
  const until = new Date(Date.now() + 3_600_000).toISOString();
  threads = [
    thread("later", 10, { snoozedUntil: until }),
    thread("old", 10, { snoozedUntil: until, archived: true }),
  ];
  runs = [run("later", "completed", 10), run("old", "completed", 10)];
  await renderApp();
  const status = (id: string) =>
    document.querySelector(`[data-flip$="${id}"] [data-status]`)?.textContent;

  act(() => drawer("Snoozed").querySelector("summary")!.click());
  expect(status("later")).toBe(`Wakes ${resumeTime(until)}`);
  act(() => drawer("Archived").querySelector("summary")!.click());
  expect(status("old")).toBe("10m");
});

const listOrder = () =>
  [...list().querySelectorAll("[data-flip]")].map((r) =>
    r.getAttribute("data-flip")!.split("/").at(-1),
  );

test("a card leads with its title, and its status is a mark with its word for screen readers (PLX-1496)", async () => {
  // Finished since it was last seen.
  threads = [thread("fresh", 10, { seenAt: ago(8) })];
  runs = [run("fresh", "completed", 5)];
  await renderApp();
  const row = document.querySelector('[data-flip$="fresh"]')!;
  const title = row.querySelector("[data-title]")!;
  const status = row.querySelector("[data-status]")!;
  expect(title.compareDocumentPosition(status) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
  // The repo's line holds the status, so nothing shares the title's line.
  expect(status.parentElement!.textContent).toBe("parallaxDone");
  expect(status.querySelector(".sr-only")!.textContent).toBe("Done");
});

test("a thread that wakes from a snooze rises to the top of the list and stays (PLX-1322)", async () => {
  capabilities = { threadAttention: {} } as Capabilities;
  threads = [
    thread("recent", 5),
    thread("timed", 60, { snoozedUntil: ago(1) }),
    thread("by-hand", 90, { snoozedUntil: new Date(Date.now() + 3_600_000).toISOString() }),
  ];
  runs = [];
  await renderApp();
  // Past its wake time, it sits above a thread active more recently than its last message.
  expect(listOrder()).toEqual(["timed", "recent"]);

  // Dragged out by hand, it wakes right away, not at the sidebar's next minute.
  if (!drawer("Snoozed").open) act(() => drawer("Snoozed").querySelector("summary")!.click());
  await dragRow("by-hand", list);
  expect(listOrder()).toEqual(["by-hand", "timed", "recent"]);

  // A later mount, as after a restart, keeps the order.
  threads = threads.map((t) => (t.id === "by-hand" ? { ...t, snoozedUntil: ago(0) } : t));
  act(() => unmount());
  await renderApp();
  expect(listOrder()).toEqual(["by-hand", "timed", "recent"]);
});

test("undoing a snooze puts a thread back where it was (PLX-1322)", async () => {
  capabilities = { threadAttention: {} } as Capabilities;
  threads = [thread("recent", 5), thread("older", 60)];
  runs = [];
  answers["thread/update"] = (p) => {
    threads = threads.map((t) =>
      t.id === p["runId"] ? { ...t, snoozedUntil: p["snoozedUntil"] as string } : t,
    );
    return { result: { thread: threads.find((t) => t.id === p["runId"]) } };
  };
  await renderApp();
  await dragRow("older", () => drawer("Snoozed"));
  expect(listOrder()).toEqual(["recent"]);

  await act(async () => button("Undo")!.click());
  await settle();
  expect(listOrder()).toEqual(["recent", "older"]);
});

test("a row dragged onto another section moves there: Archived archives, Snoozed snoozes, and the list brings it back (PLX-1095)", async () => {
  capabilities = { threadAttention: {} } as Capabilities;
  threads = [
    thread("later", 10),
    thread("finished", 10),
    thread("old", 10, { archived: true }),
    thread("keep", 10, { archived: true }),
  ];
  runs = [run("later", "completed", 10), run("finished", "completed", 10)];
  await renderApp();
  // Nothing is snoozed, so Snoozed shows only while a row drags.
  expect(drawer("Snoozed")).toBeUndefined();

  await dragRow("later", () => drawer("Snoozed"));
  const snoozed = request.mock.calls.find(([, m]) => m === "thread/update")?.[2];
  expect(snoozed).toMatchObject({ runId: "later" });
  expect(Date.parse(snoozed!["snoozedUntil"] as string)).toBeGreaterThan(Date.now() + 59 * 60_000);

  await dragRow("finished", () => drawer("Archived"));
  await waitForArchives(1);
  expect(archived()).toEqual(["finished"]);

  if (!drawer("Archived").open) act(() => drawer("Archived").querySelector("summary")!.click());
  await dragRow("old", list);
  expect(request).toHaveBeenCalledWith("local", "thread/archive", {
    runId: "old",
    archived: false,
  });
  // Dropped on the pins, it comes back pinned.
  await dragRow("keep", () => document.querySelector('[aria-label="Pinned"]')!.parentElement!);
  expect(request).toHaveBeenCalledWith("local", "thread/archive", {
    runId: "keep",
    archived: false,
  });
  expect(request).toHaveBeenCalledWith("local", "thread/update", { runId: "keep", pinned: true });
});

test("a row's +N opens its thread's Pull requests list, and a lone #n opens that pull request (PLX-1241)", async () => {
  capabilities = { pullRequests: {} } as Capabilities;
  const url = (n: number) => `https://github.com/me/app/pull/${n}`;
  threads = [thread("t-many", 1), thread("t-one", 2)];
  runs = [
    { ...run("t-many", "completed", 1), pullRequests: [url(1), url(2), url(3)] },
    { ...run("t-one", "completed", 2), pullRequests: [url(4)] },
  ];
  answers["pr/view"] = (p) => ({
    result: { ...samplePr, url: p["url"], number: Number(String(p["url"]).split("/").at(-1)) },
  });
  await renderApp();
  const chip = (text: string) =>
    [...document.querySelectorAll<HTMLElement>('[title*="linked pull request"] span')].find(
      (s) => s.textContent === text,
    );
  const tab = () =>
    document.querySelector('#side-panel [aria-label="Open views"] button[aria-current="true"]')
      ?.textContent;

  await act(async () => chip("+2")!.click());
  await settle();
  expect(chip("+2")!.closest("button")?.getAttribute("aria-current")).toBe("page");
  expect(tab()).toBe("Pull requests");
  expect(
    document.querySelector('#side-panel ul[aria-label="Pull requests"]')?.children,
  ).toHaveLength(3);

  await act(async () => chip("#4")!.click());
  await settle();
  expect(chip("#4")!.closest("button")?.getAttribute("aria-current")).toBe("page");
  expect(tab()).toBe("#4");
});
