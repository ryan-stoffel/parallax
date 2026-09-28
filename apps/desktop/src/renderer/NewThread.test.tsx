// @vitest-environment happy-dom
import { act } from "react";
import { createRoot } from "react-dom/client";
import { afterEach, beforeEach, expect, test, vi } from "vite-plus/test";

import type { RpcResponse, WispBridge } from "../preload/bridge";
import type { Repo, Thread } from "../protocol/generated/protocol";
import { App } from "./App";

Object.assign(globalThis, { IS_REACT_ACT_ENVIRONMENT: true });
// happy-dom has no popovers. The row menu's buttons are in the DOM either way.
HTMLElement.prototype.hidePopover = () => {};

const wisp: Repo = {
  id: "r-wisp",
  name: "wisp",
  path: "/src/wisp",
  createdAt: "2026-09-26T12:00:00Z",
};
const thread: Thread = { id: "t-1", repo: wisp.id, createdAt: "2026-09-26T12:00:01Z" };
const run = (id: string, prompt: string) => ({ id, prompt, status: "running" });

type Answer = (params: Record<string, unknown>) => RpcResponse<unknown>;
let answers: Record<string, Answer>;
const request = vi.fn(async (_host: string, method: string, params: Record<string, unknown>) => {
  const answer = answers[method];
  return answer ? answer(params) : { error: { code: -32601, message: `${method} isn't faked` } };
});
const pickFolder = vi.fn<() => Promise<string | null>>();

beforeEach(() => {
  request.mockClear();
  answers = {
    "thread/list": () => ({ result: { repos: [wisp], threads: [thread], seq: 7 } }),
    "agent/list": () => ({
      result: { runs: [run(thread.id, "Fix the flaky test\nPlease.")], seq: 7 },
    }),
  };
  window.wisp = {
    platform: "darwin",
    setThemeSource: vi.fn(),
    connectionState: async () => ({ status: "connected", wispd: "0.1.0", protocol: 1 }),
    onConnectionState: () => () => {},
    subscribe: () => () => {},
    request,
    pickFolder,
  } as Partial<WispBridge> as WispBridge;
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
const button = (name: string) =>
  [...document.querySelectorAll("button")].find(
    (b) => b.textContent === name || b.getAttribute("aria-label") === name,
  );
// A thread's row: its title, then its age.
const threadRow = (title: string) =>
  [...document.querySelectorAll("#sidebar li > button:first-child")].find((b) =>
    b.textContent?.startsWith(title),
  );
const calls = (method: string) =>
  request.mock.calls.filter(([, m]) => m === method).map(([, , params]) => params);
const heading = () => document.querySelector("h1")?.textContent;
const crumbs = () =>
  [...document.querySelectorAll('[aria-label="Breadcrumb"] li')].map((li) => li.textContent);

async function choose(label: string, value: string) {
  // A Picker is a <label> whose first child names it.
  const picker = [...document.querySelectorAll("label")]
    .find((l) => l.firstElementChild?.textContent === label)!
    .querySelector("select")!;
  await act(async () => {
    picker.value = value;
    picker.dispatchEvent(new Event("change", { bubbles: true }));
  });
  await settle();
}

async function send(text: string) {
  const box = document.querySelector("textarea")!;
  act(() => {
    Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype, "value")!.set!.call(box, text);
    box.dispatchEvent(new Event("input", { bubbles: true }));
  });
  await act(async () => {
    box.dispatchEvent(new KeyboardEvent("keydown", { key: "Enter", bubbles: true }));
  });
  await settle();
}

test("lists threads by repository, titled by their first prompt line, with No Repo last", async () => {
  await renderApp();
  const groups = [...document.querySelectorAll('[aria-labelledby="repositories-heading"] > div')];
  expect(groups.map((g) => g.querySelector("button")!.textContent)).toEqual(["wisp", "No Repo"]);
  expect(groups[0]!.contains(threadRow("Fix the flaky test")!)).toBe(true);
  expect(heading()).toBe("What should we build in wisp?");
});

test("New Thread adds a picked folder, starts there, and reuses its run id on a retry", async () => {
  const other: Repo = { ...wisp, id: "", name: "other", path: "/src/other" };
  pickFolder.mockResolvedValue("/src/other");
  answers["repo/add"] = (p) => ({ result: { repo: { ...other, id: p["id"] } } });
  await renderApp();

  await choose("Repository", "add-repository");
  expect(calls("repo/add")).toEqual([
    { id: expect.stringMatching(/^[0-9a-f-]{14}7/), path: "/src/other" },
  ]);
  expect(heading()).toBe("What should we build in other?");

  // The first try fails, the retry with the same prompt succeeds.
  answers["thread/start"] = () => ({ error: { code: -32000, message: "wispd is busy" } });
  await send("Tidy the README");
  expect(document.querySelector('[role="alert"]')?.textContent).toBe("wispd is busy");
  answers["thread/start"] = (p) => ({
    result: {
      thread: { id: p["runId"], repo: p["repo"], createdAt: "2026-09-26T12:05:00Z" },
      run: run(p["runId"] as string, "Tidy the README"),
    },
  });
  await send("Tidy the README");

  const [first, retry] = calls("thread/start");
  expect(first).toEqual({
    runId: expect.any(String),
    repo: calls("repo/add")[0]!["id"],
    prompt: "Tidy the README",
  });
  expect(retry).toEqual(first);
  // The thread opens, and its row is in the sidebar under its repository.
  expect(crumbs()).toEqual(["This Mac", "other", "Tidy the README"]);
  expect(threadRow("Tidy the README")?.getAttribute("aria-current")).toBe("page");
});

test("No Repo starts a thread with no repo", async () => {
  answers["thread/start"] = (p) => ({
    result: {
      thread: { id: p["runId"], repo: "scratch", createdAt: "2026-09-26T12:05:00Z" },
      run: run(p["runId"] as string, "Hi"),
    },
  });
  await renderApp();
  await choose("Repository", "no-repo");
  expect(heading()).toBe("What should we work on?");
  await send("Hi");
  expect(calls("thread/start")).toEqual([{ runId: expect.any(String), prompt: "Hi" }]);
  expect(crumbs()).toEqual(["This Mac", "No Repo", "Hi"]);
});

test("a folder that isn't a repository says so under the composer", async () => {
  pickFolder.mockResolvedValue("/tmp/notes");
  answers["repo/add"] = () => ({
    error: {
      code: -32000,
      message: "/tmp/notes is not the top folder of a git repository: it has no .git.",
      data: { kind: "notARepository" },
    },
  });
  await renderApp();
  await choose("Repository", "add-repository");
  expect(document.querySelector('[role="alert"]')?.textContent).toBe(
    "/tmp/notes is not the top folder of a git repository: it has no .git.",
  );
  expect(heading()).toBe("What should we build in wisp?");
});

test("the row menu archives into Archived, and unarchives back", async () => {
  answers["thread/archive"] = (p) => ({
    result: { thread: { ...thread, archived: p["archived"] } },
  });
  await renderApp();
  await act(async () => button("Archive")!.click());
  expect(calls("thread/archive")).toEqual([{ runId: thread.id, archived: true }]);
  const archived = document.querySelector("details")!;
  expect(archived.textContent).toContain("Fix the flaky test");

  await act(async () => button("Unarchive")!.click());
  expect(calls("thread/archive").at(-1)).toEqual({ runId: thread.id, archived: false });
  expect(document.querySelector("details")).toBeNull();
});

test("Delete asks first, and only deletes once confirmed", async () => {
  answers["thread/delete"] = () => ({ result: {} });
  await renderApp();
  await act(async () => button("Thread actions")!.click());
  await act(async () => button("Delete…")!.click());
  const dialog = document.querySelector<HTMLDialogElement>(
    '[aria-labelledby="delete-thread-title"]',
  )!;
  expect(dialog.open).toBe(true);
  expect(dialog.textContent).toContain("Fix the flaky test");

  await act(async () => button("Cancel")!.click());
  expect(dialog.open).toBe(false);
  expect(calls("thread/delete")).toEqual([]);

  await act(async () => button("Delete…")!.click());
  await act(async () => button("Delete")!.click());
  await settle();
  expect(calls("thread/delete")).toEqual([{ runId: thread.id }]);
  expect(dialog.open).toBe(false);
  expect(threadRow("Fix the flaky test")).toBeUndefined();
});
