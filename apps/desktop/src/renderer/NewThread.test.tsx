// @vitest-environment happy-dom
import type { TiptapEditorHTMLElement } from "@tiptap/react";
import { act } from "react";
import { createRoot } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, test, vi } from "vite-plus/test";

import type { RpcResponse, SubscriptionMessage, ParallaxBridge } from "../preload/bridge";
import type { Capabilities, ErrorKind, Repo, Thread } from "../protocol/generated/protocol";
import { App } from "./App";

Object.assign(globalThis, { IS_REACT_ACT_ENVIRONMENT: true });
// happy-dom has no popovers. The row menu's buttons are in the DOM either way.
HTMLElement.prototype.hidePopover = () => {};
// happy-dom lays nothing out. A tall transcript with small rows renders every row.
Object.defineProperty(HTMLElement.prototype, "offsetHeight", {
  get(this: HTMLElement) {
    return this.getAttribute("role") === "log" ? 10_000 : 20;
  },
});

const parallax: Repo = {
  id: "r-parallax",
  name: "parallax",
  path: "/src/parallax",
  createdAt: "2026-09-26T12:00:00Z",
};
const thread: Thread = { id: "t-1", repo: parallax.id, createdAt: "2026-09-26T12:00:01Z" };
const run = (id: string, prompt: string, status = "running") => ({ id, prompt, status });

type Answer = (params: Record<string, unknown>) => RpcResponse<unknown>;
let answers: Record<string, Answer>;
const request = vi.fn(async (_host: string, method: string, params: Record<string, unknown>) => {
  const answer = answers[method];
  return answer ? answer(params) : { error: { code: -32601, message: `${method} isn't faked` } };
});
const pickFolder = vi.fn<() => Promise<string | null>>();
let capabilities: Capabilities;
const nameThread = vi.fn<ParallaxBridge["nameThread"]>(async () => ({}));

beforeEach(() => {
  request.mockClear();
  capabilities = {};
  nameThread.mockReset().mockResolvedValue({});
  localStorage.clear();
  answers = {
    "thread/list": () => ({ result: { repos: [parallax], threads: [thread], seq: 7 } }),
    "agent/list": () => ({
      result: { runs: [run(thread.id, "Fix the flaky test\nPlease.")], seq: 7 },
    }),
    "project/list": () => ({ result: { projects: [], seq: 7 } }),
  };
  window.parallax = {
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
    pickFolder,
    hosts: async () => [],
    onHosts: () => () => {},
    openTargets: async () => [],
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
const button = (name: string) =>
  [...document.querySelectorAll("button")].find(
    (b) => b.textContent === name || b.getAttribute("aria-label") === name,
  );
// A thread's row, by its title.
const threadRow = (title: string) =>
  [...document.querySelectorAll('#sidebar li[data-kind="thread"] > button:first-child')].find((b) =>
    b.querySelector("[data-title]")?.textContent?.startsWith(title),
  );
const calls = (method: string) =>
  request.mock.calls.filter(([, m]) => m === method).map(([, , params]) => params);
const heading = () => document.querySelector("h1")?.textContent;
const crumbs = () =>
  [...document.querySelectorAll('[aria-label="Breadcrumb"] li')].map((li) => li.textContent);

// A main pane menu's option. The sidebar's Create Project dialog has a Repository menu too.
async function choose(label: string, option: string) {
  const item = [
    ...document.querySelectorAll<HTMLElement>(
      `main [role="menu"][aria-label="${label}"] [role="menuitemradio"]`,
    ),
  ].find((b) => b.textContent === option)!;
  await act(async () => item.click());
  await settle();
}

// A composer control by its label, in the main pane.
const control = (label: string) => document.querySelector(`main [aria-label="${label}"]`);
// Clicks the main pane's first menu item whose text starts with `text`.
async function pick(text: string) {
  const item = [...document.querySelectorAll<HTMLElement>('main [role="menuitemradio"]')].find(
    (b) => b.textContent?.startsWith(text),
  )!;
  await act(async () => item.click());
}

// The composer's editor, which Tiptap keeps on its element for tests.
const composer = () =>
  document.querySelector<TiptapEditorHTMLElement>('[role="textbox"][aria-label="Message"]')!;

async function send(text: string) {
  const box = composer();
  act(() => void box.editor!.commands.setContent(text));
  await act(async () => {
    box.dispatchEvent(new KeyboardEvent("keydown", { key: "Enter", bubbles: true }));
  });
  await settle();
}

test("lists threads in one list, titled by their first prompt line, each under its repo's name", async () => {
  await renderApp();
  const row = threadRow("Fix the flaky test")!;
  expect(row.querySelector("[data-title]")!.textContent).toBe("Fix the flaky test");
  expect(row.textContent).toContain("parallax");
  expect(document.querySelector("#repositories-heading")).toBeNull();
  expect(heading()).toBe("What should we build in parallax?");
});

test("New Thread adds a picked folder, starts there, and reuses its run id on a retry", async () => {
  const other: Repo = { ...parallax, id: "", name: "other", path: "/src/other" };
  pickFolder.mockResolvedValue("/src/other");
  answers["repo/add"] = (p) => ({ result: { repo: { ...other, id: p["id"] } } });
  await renderApp();

  await choose("Repository", "Add repository…");
  expect(calls("repo/add")).toEqual([
    { id: expect.stringMatching(/^[0-9a-f-]{14}7/), path: "/src/other" },
  ]);
  expect(heading()).toBe("What should we build in other?");

  // The first try fails, the retry with the same prompt succeeds.
  answers["thread/start"] = () => ({ error: { code: -32000, message: "plxd is busy" } });
  await send("Tidy the README");
  expect(document.querySelector('[role="alert"]')?.textContent).toBe("plxd is busy");
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

// The transcript's message bubble, and the musing under it until the agent does anything.
const bubble = () => document.querySelector('[role="log"] .bg-selected')?.textContent;
const musing = () =>
  document.querySelector('[role="log"] button[aria-expanded] .sr-only')?.textContent;

test("Send shows the prompt at once while plxd starts the thread, and a failure puts it back", async () => {
  let answer: (response: RpcResponse<unknown>) => void = () => {};
  answers["thread/start"] = () =>
    new Promise((resolve) => (answer = resolve)) as unknown as RpcResponse<unknown>;
  await renderApp();
  await send("Tidy the README");
  expect(heading()).toBeUndefined();
  expect(bubble()).toBe("Tidy the README");
  expect(document.querySelector('[role="log"] [class*="opacity"]')).toBeNull();
  expect(musing()).toBe("Working");
  expect(composer().getAttribute("aria-placeholder")).toBe("Starting thread…");

  await act(async () => answer({ error: { code: -32000, message: "plxd is busy" } }));
  await settle();
  expect(heading()).toBe("What should we build in parallax?");
  expect(composer().textContent).toBe("Tidy the README");
  expect(document.querySelector('[role="alert"]')?.textContent).toBe("plxd is busy");
  expect(document.querySelector(".loader")).toBeNull();
});

test("the loader under the prompt carries on as the thread opens and loads", async () => {
  let answer = () => {};
  answers["thread/start"] = (p) =>
    new Promise((resolve) => {
      answer = () =>
        resolve({
          result: {
            thread: { id: p["runId"], repo: p["repo"], createdAt: "2026-09-26T12:05:00Z" },
            run: run(p["runId"] as string, "Tidy the README", "starting"),
          },
        });
    }) as unknown as RpcResponse<unknown>;
  // The opened thread's transcript is still on its way.
  answers["agent/events"] = () => new Promise(() => {}) as unknown as RpcResponse<unknown>;
  await renderApp();
  await send("Tidy the README");
  expect(musing()).toBe("Working");

  await act(async () => answer());
  await settle();
  expect(crumbs()).toEqual(["This Mac", "parallax", "Tidy the README"]);
  expect(bubble()).toBe("Tidy the README");
  expect(musing()).toBe("Working");
  // Its word carries on rather than fading in again.
  expect(document.querySelector('[role="log"] .working-in')).toBeNull();
});

test("a thread started here that finished reopens with no loader while its transcript loads", async () => {
  answers["thread/start"] = (p) => ({
    result: {
      thread: { id: p["runId"], repo: parallax.id, createdAt: "2026-09-26T12:05:00Z" },
      run: run(p["runId"] as string, "Tidy the README", "starting"),
    },
  });
  // Each run's log: it started, and it's already done. Then, once `held`, none comes.
  let held = false;
  answers["agent/events"] = (p) => {
    if (held) return new Promise(() => {}) as unknown as RpcResponse<unknown>;
    const done = {
      ...run(p["runId"] as string, "Tidy the README", "completed"),
      project: parallax.id,
      backend: "claude",
    };
    const events = [
      {
        seq: 1,
        time: "2026-09-26T12:05:00Z",
        event: { kind: "agent.started", runId: done.id, run: done },
      },
    ];
    const after = p["after"] as number;
    return {
      result: { events: events.filter((e) => e.seq > after), more: false },
      logId: "log-1",
    } as RpcResponse<unknown>;
  };
  await renderApp();
  await send("Tidy the README");
  expect(crumbs()).toEqual(["This Mac", "parallax", "Tidy the README"]);
  expect(bubble()).toBe("Tidy the README");
  expect(document.querySelector(".loader")).toBeNull();

  // The host's list still says it's starting, but it isn't the thread just started anymore.
  await act(async () => (threadRow("Fix the flaky test") as HTMLElement).click());
  await settle();
  held = true;
  await act(async () => (threadRow("Tidy the README") as HTMLElement).click());
  await settle();
  expect(crumbs()).toEqual(["This Mac", "parallax", "Tidy the README"]);
  expect(bubble()).toBe("Tidy the README");
  expect(document.querySelector(".loader")).toBeNull();
  expect(musing()).toBeUndefined();
  expect(document.querySelector("main")!.textContent).not.toContain("Working");
});

test("a finished thread opens on its prompt with no loader while its transcript loads", async () => {
  answers["agent/list"] = () => ({
    result: { runs: [run(thread.id, "Fix the flaky test", "completed")], seq: 7 },
  });
  answers["agent/events"] = () => new Promise(() => {}) as unknown as RpcResponse<unknown>;
  await renderApp();
  await act(async () => (threadRow("Fix the flaky test") as HTMLElement).click());
  await settle();
  expect(crumbs()).toEqual(["This Mac", "parallax", "Fix the flaky test"]);
  expect(bubble()).toBe("Fix the flaky test");
  expect(document.querySelector(".loader")).toBeNull();
  expect(musing()).toBeUndefined();
});

test("No Repo starts a thread with no repo", async () => {
  answers["thread/start"] = (p) => ({
    result: {
      thread: { id: p["runId"], repo: "scratch", createdAt: "2026-09-26T12:05:00Z" },
      run: run(p["runId"] as string, "Hi"),
    },
  });
  await renderApp();
  await choose("Repository", "No Repo");
  expect(heading()).toBe("What should we work on without a repo?");
  await send("Hi");
  expect(calls("thread/start")).toEqual([{ runId: expect.any(String), prompt: "Hi" }]);
  expect(crumbs()).toEqual(["This Mac", "No Repo", "Hi"]);
});

test("a new thread asks plxd to forward its permission requests only when plxd advertises approvals (RYA-196)", async () => {
  answers["thread/start"] = (p) => ({
    result: {
      thread: { id: p["runId"], repo: parallax.id, createdAt: "2026-09-26T12:05:00Z" },
      run: run(p["runId"] as string, "Hi"),
    },
  });
  // An older plxd never gets the flag.
  await renderApp();
  await send("Hi");
  act(() => unmount());
  capabilities = { approvals: {} };
  await renderApp();
  await send("Hi");
  const [older, newer] = calls("thread/start");
  expect(older).not.toHaveProperty("approvals");
  expect(newer).toMatchObject({ prompt: "Hi", approvals: true });
});

describe("with plxd's run options", () => {
  const started = (p: Record<string, unknown>) => ({
    result: {
      thread: { id: p["runId"], repo: p["repo"], createdAt: "2026-09-26T12:05:00Z" },
      run: run(p["runId"] as string, p["prompt"] as string),
    },
  });
  beforeEach(() => {
    capabilities = { runOptions: {} };
    answers["accounts/defaults/get"] = () => ({ result: {} });
    answers["thread/start"] = started;
  });

  test("Manual says its requests come to the chat only when plxd advertises approvals (RYA-196)", async () => {
    const manual = () =>
      [
        ...document.querySelectorAll(
          'main [role="menu"][aria-label="Access"] [role="menuitemradio"]',
        ),
      ].find((o) => o.textContent?.startsWith("Manual"))!.textContent;
    await renderApp();
    expect(manual()).toBe(
      "ManualAsks before edits and commands. This host's plxd can't show those requests, so they're denied.",
    );
    act(() => unmount());
    capabilities = { runOptions: {}, approvals: {} };
    await renderApp();
    expect(manual()).toBe("ManualAsks you before edits and commands.");
  });

  test("New Thread sends the model, effort, and access it shows, and a changed one is a new start", async () => {
    // Refused at Max, then started at Extra high.
    answers["thread/start"] = (p) =>
      p["effort"] === "max"
        ? {
            error: {
              code: -32000,
              message: "the claude backend can't run with effort max",
              data: { kind: "unsupportedOption" },
            },
          }
        : started(p);
    await renderApp();
    // No worker default yet, so Claude's choices, as the account chooser only offers Claude.
    expect(control("Model: Claude Opus 5.5")).not.toBeNull();
    expect(control("Access: Accept Edits")).not.toBeNull();

    await pick("Claude Fable 5.1");
    await pick("Plan");
    const effort = (level: string) =>
      act(() => {
        const slider = document.querySelector<HTMLInputElement>('main input[type="range"]')!;
        Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, "value")!.set!.call(
          slider,
          level,
        );
        slider.dispatchEvent(new Event("input", { bubbles: true }));
      });
    effort("4");
    await send("Plan the settings split");
    expect(document.querySelector('[role="alert"]')?.textContent).toBe(
      "the claude backend can't run with effort max",
    );
    effort("3");
    await send("Plan the settings split");

    const [refused, retry] = calls("thread/start");
    expect(refused).toEqual({
      runId: expect.any(String),
      repo: parallax.id,
      prompt: "Plan the settings split",
      model: "claude-fable-5-1",
      effort: "max",
      permission: "plan",
    });
    expect(retry).toEqual({ ...refused, runId: expect.any(String), effort: "xhigh" });
    expect(retry!["runId"]).not.toBe(refused!["runId"]);
  });

  test("on a plxd that takes them, New Thread sends the context window and fast mode", async () => {
    capabilities = { runOptions: {}, contextAndFast: {} };
    await renderApp();
    expect(control("Reasoning effort: High · 1M")).not.toBeNull();
    await pick("200K");
    await send("Tidy the README");
    expect(calls("thread/start")).toEqual([
      {
        runId: expect.any(String),
        repo: parallax.id,
        prompt: "Tidy the README",
        model: "claude-opus-5-5",
        effort: "high",
        permission: "edit",
        contextWindow: 200_000,
        fast: false,
      },
    ]);
  });

  test("an OpenAI key default offers Codex's models and no plan", async () => {
    answers["accounts/defaults/get"] = () => ({ result: { worker: { kind: "key", id: "k-1" } } });
    answers["accounts/keys/list"] = () => ({
      result: { accounts: [{ id: "k-1", provider: "openai", label: "Work" }] },
    });
    await renderApp();
    expect(control("Model: GPT-6 Astra")).not.toBeNull();
    expect(document.querySelector('main [aria-label^="Access"]')).toBeNull();

    await send("Tidy the README");
    expect(calls("thread/start")).toEqual([
      {
        runId: expect.any(String),
        repo: parallax.id,
        prompt: "Tidy the README",
        model: "gpt-6-astra",
        effort: "high",
        permission: "edit",
      },
    ]);
  });
});

test("without run options, New Thread offers no model, effort, or access", async () => {
  await renderApp();
  expect(
    document.querySelector('main :is([aria-label^="Model"], [aria-label^="Reasoning"])'),
  ).toBeNull();
  expect(calls("accounts/defaults/get")).toEqual([]);
});

test("a thread starts on the branch its prompt was named for, and takes the name as its title", async () => {
  nameThread.mockResolvedValue({ title: "Fix flaky test", slug: "fix-flaky-test" });
  answers["thread/start"] = (p) => ({
    result: {
      thread: { id: p["runId"], repo: parallax.id, createdAt: "2026-09-26T12:05:00Z" },
      run: run(p["runId"] as string, "the flaky test is flaky, please fix it"),
    },
  });
  await renderApp();
  await send("the flaky test is flaky, please fix it");
  expect(calls("thread/start")).toEqual([
    {
      runId: expect.any(String),
      prompt: "the flaky test is flaky, please fix it",
      repo: parallax.id,
      branchSlug: "fix-flaky-test",
    },
  ]);
  expect(crumbs()).toEqual(["This Mac", "parallax", "Fix flaky test"]);
});

test("Current checkout starts a thread in the repository itself, with no branch of its own", async () => {
  capabilities = { checkout: {} };
  nameThread.mockResolvedValue({ title: "Fix flaky test", slug: "fix-flaky-test" });
  answers["thread/start"] = (p) => ({
    result: {
      thread: { id: p["runId"], repo: parallax.id, createdAt: "2026-09-26T12:05:00Z" },
      run: run(p["runId"] as string, "Fix it"),
    },
  });
  await renderApp();
  expect(control("Runs on: This Mac, New worktree")).not.toBeNull();
  await choose("Runs on", "Current checkoutRight in the repository, on the branch you have out.");
  expect(control("Runs on: This Mac, Current checkout")).not.toBeNull();
  await send("Fix it");
  expect(calls("thread/start")).toEqual([
    { runId: expect.any(String), prompt: "Fix it", repo: parallax.id, checkout: true },
  ]);
});

describe("the ref picker", () => {
  beforeEach(() => {
    answers["repo/refs"] = () => ({
      result: {
        refs: [
          { name: "develop", default: true, current: true },
          { name: "feature", worktree: true },
          { name: "origin/develop", remote: true },
        ],
      },
    });
    answers["thread/start"] = (p) => ({
      result: {
        thread: { id: p["runId"], repo: parallax.id, createdAt: "2026-09-26T12:05:00Z" },
        run: run(p["runId"] as string, "Fix it"),
      },
    });
  });

  test("a new worktree starts from the checkout's branch, or from the ref picked", async () => {
    capabilities = { repoRefs: {} };
    await renderApp();
    expect(button("From develop")).toBeDefined();
    await choose("Ref", "origin/develop");
    expect(button("From origin/develop")).toBeDefined();
    await send("Fix it");
    expect(calls("thread/start")).toEqual([
      { runId: expect.any(String), prompt: "Fix it", repo: parallax.id, base: "origin/develop" },
    ]);
  });

  test("the current checkout switches to the ref picked first", async () => {
    capabilities = { checkout: {}, repoRefs: {} };
    await renderApp();
    await choose("Runs on", "Current checkoutRight in the repository, on the branch you have out.");
    expect(button("Select ref")).toBeDefined();
    await choose("Ref", "featureworktree");
    expect(button("feature")).toBeDefined();
    await send("Fix it");
    expect(calls("thread/start")).toEqual([
      {
        runId: expect.any(String),
        prompt: "Fix it",
        repo: parallax.id,
        checkout: true,
        checkoutRef: "feature",
      },
    ]);
  });

  test("a new worktree's ref never becomes the checkout's switch", async () => {
    capabilities = { checkout: {}, repoRefs: {} };
    await renderApp();
    await choose("Ref", "origin/develop");
    await choose("Runs on", "Current checkoutRight in the repository, on the branch you have out.");
    expect(button("Select ref")).toBeDefined();
    await send("Fix it");
    expect(calls("thread/start")).toEqual([
      { runId: expect.any(String), prompt: "Fix it", repo: parallax.id, checkout: true },
    ]);
  });

  test("a plxd without repoRefs shows no ref picker", async () => {
    await renderApp();
    expect(document.querySelector('main [role="menu"][aria-label="Ref"]')).toBeNull();
    expect(calls("repo/refs")).toEqual([]);
  });
});

test("Current checkout can't be picked without a repo, or from a plxd that would make a worktree anyway", async () => {
  const checkoutOption = () =>
    [
      ...document.querySelectorAll<HTMLButtonElement>(
        'main [role="menu"][aria-label="Runs on"] [role="menuitemradio"]',
      ),
    ].find((b) => b.textContent?.startsWith("Current checkout"))!;
  await renderApp();
  expect(checkoutOption().disabled).toBe(true);
  expect(checkoutOption().textContent).toContain("needs a newer plxd");
  act(() => unmount());

  capabilities = { checkout: {} };
  await renderApp();
  expect(checkoutOption().disabled).toBe(false);
  await act(async () => checkoutOption().click());
  await choose("Repository", "No Repo");
  expect(checkoutOption().disabled).toBe(true);
  expect(checkoutOption().textContent).toContain("needs a repo");
  expect(control("Runs on: This Mac, New worktree")).not.toBeNull();
});

test("a thread can start with an image alone, titled Image, and nothing to name it by", async () => {
  capabilities = {
    promptImages: { maxImages: 10, maxImageBytes: 5_242_880, maxTotalBytes: 6_291_456 },
  };
  vi.stubGlobal("createImageBitmap", async () => ({ width: 1, height: 1, close() {} }));
  answers["thread/start"] = (p) => ({
    result: {
      thread: { id: p["runId"], repo: parallax.id, createdAt: "2026-09-26T12:05:00Z" },
      run: run(p["runId"] as string, ""),
    },
  });
  await renderApp();
  const data = new DataTransfer();
  data.items.add(new File([Uint8Array.of(0xff, 0xd8, 0xff)], "a.jpg", { type: "image/jpeg" }));
  act(() => {
    composer().dispatchEvent(new ClipboardEvent("paste", { clipboardData: data, bubbles: true }));
  });
  await act(() => new Promise((resolve) => setTimeout(resolve, 20)));
  await send("");
  expect(calls("thread/start")).toEqual([
    {
      runId: expect.any(String),
      prompt: "",
      images: [{ mediaType: "image/jpeg", data: "/9j/" }],
      repo: parallax.id,
    },
  ]);
  expect(nameThread).not.toHaveBeenCalled();
  expect(crumbs()).toEqual(["This Mac", "parallax", "Image"]);
  vi.unstubAllGlobals();
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
  await choose("Repository", "Add repository…");
  expect(document.querySelector('[role="alert"]')?.textContent).toBe(
    "/tmp/notes is not the top folder of a git repository: it has no .git.",
  );
  expect(heading()).toBe("What should we build in parallax?");
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

describe("a host with no usable default account for threads", () => {
  const cli = (name: string, signedIn?: boolean) => ({ cli: name, installed: true, signedIn });
  const key = (id: string, provider: string) => ({ id, provider, label: id, masked: "sk-…abcd" });
  const accounts = (clis: object[], keys: object[] = []) => {
    answers["accounts/list"] = () => ({ result: { clis, checkedAt: "2026-09-26T12:00:00Z" } });
    answers["accounts/keys/list"] = () => ({ result: { accounts: keys } });
  };
  const chooserLabels = () =>
    [...document.querySelectorAll("fieldset label")].map((l) => l.textContent);
  // `thread/start` fails with `failure` until a default is set.
  let failure: ErrorKind;
  beforeEach(() => {
    failure = "noDefaultAccount";
    let worker: unknown;
    answers["accounts/defaults/set"] = (p) => {
      worker = p["account"];
      return { result: { worker } };
    };
    answers["thread/start"] = (p) =>
      worker
        ? {
            result: {
              thread: { id: p["runId"], repo: p["repo"], createdAt: "2026-09-26T12:05:00Z" },
              run: run(p["runId"] as string, p["prompt"] as string),
            },
          }
        : { error: { code: -32000, message: "raw protocol text", data: { kind: failure } } };
  });

  test("asks which account to use, sets it as the default, and retries the same start", async () => {
    // Only Claude runs threads today, so Codex, Cursor, and an OpenAI key aren't offered.
    accounts(
      [cli("claude", true), cli("codex", true), cli("cursor", false)],
      [key("Work", "anthropic"), key("Other", "openai")],
    );
    await renderApp();
    await send("Tidy the README");

    const chooser = document.querySelector("fieldset")!;
    expect(chooser.querySelector("legend")?.textContent).toContain(
      "Choose an account to run this thread",
    );
    expect(chooserLabels()).toEqual(["Claude Code", "Work (API key)"]);
    expect(document.activeElement).toBe(chooser.querySelector("input:checked"));
    // No raw protocol text, and the prompt stays in the box.
    expect(document.body.textContent).not.toContain("raw protocol text");
    expect(composer().textContent).toBe("Tidy the README");

    await act(async () => chooser.querySelectorAll("input")[1]!.click());
    await act(async () => button("Continue")!.click());
    await settle();
    expect(calls("accounts/defaults/set")).toEqual([
      { role: "worker", account: { kind: "key", id: "Work" } },
    ]);
    const [first, retry] = calls("thread/start");
    expect(retry).toEqual(first);
    expect(crumbs()).toEqual(["This Mac", "parallax", "Tidy the README"]);
  });

  test("a default naming a removed key account asks again", async () => {
    failure = "accountNotFound";
    accounts([cli("claude", true)], [key("Work", "anthropic")]);
    await renderApp();
    await send("Hi");
    expect(chooserLabels()).toEqual(["Claude Code", "Work (API key)"]);
  });

  test("uses the only account there is, and says so", async () => {
    accounts([cli("claude", true), cli("codex", true)], [key("Other", "openai")]);
    await renderApp();
    await send("Hi");
    expect(document.querySelector("fieldset")).toBeNull();
    expect(calls("accounts/defaults/set")).toEqual([
      { role: "worker", account: { kind: "subscription", backend: "claude" } },
    ]);
    const [first, retry] = calls("thread/start");
    expect(retry).toEqual(first);
    expect(crumbs()).toEqual(["This Mac", "parallax", "Hi"]);
    expect(document.querySelector("main")!.textContent).toContain(
      "Using Claude Code for new threads on this host.",
    );
  });

  test("shows plxd's error when it can't list accounts", async () => {
    accounts([]);
    answers["accounts/list"] = () => ({ error: { code: -32601, message: "Method not found" } });
    await renderApp();
    await send("Hi");
    expect(document.querySelector('[role="alert"]')?.textContent).toBe("Method not found");
  });

  test("says how to add one when there is none", async () => {
    accounts([cli("claude", false)]);
    await renderApp();
    await send("Hi");
    expect(document.querySelector('[role="alert"]')?.textContent).toBe(
      "No account can run this thread yet. Sign in to Claude Code, or add an API key, then try again.",
    );
    expect(calls("accounts/defaults/set")).toEqual([]);
  });
});

test("known error kinds read plainly, and unknown ones show plxd's message", async () => {
  const alert = () => document.querySelector('[role="alert"]')?.textContent;
  answers["thread/start"] = () => ({
    error: { code: -32000, message: "no repo entry has id r-9", data: { kind: "repoNotFound" } },
  });
  await renderApp();
  await send("Hi");
  expect(alert()).toBe("That repository isn't in Parallax anymore. Choose another one.");

  answers["thread/start"] = () => ({
    // A kind from a newer plxd.
    error: {
      code: -32000,
      message: "plxd is shy today",
      data: { kind: "somethingNew" as ErrorKind },
    },
  });
  await send("Hi");
  expect(alert()).toBe("plxd is shy today");
});

test("an open thread deleted by another client goes back to New Thread", async () => {
  let deliver: (message: SubscriptionMessage) => void = () => {};
  window.parallax.subscribe = (_host, _params, listener) => {
    deliver = listener;
    return () => {};
  };
  await renderApp();
  await act(async () => (threadRow("Fix the flaky test") as HTMLElement).click());
  expect(crumbs()).toEqual(["This Mac", "parallax", "Fix the flaky test"]);

  await act(async () =>
    deliver({
      type: "event",
      event: {
        subscription: "s-1",
        seq: 8,
        time: "2026-09-26T12:06:00Z",
        event: { kind: "thread.deleted", runId: thread.id, repo: parallax.id },
      },
    }),
  );
  await settle();
  expect(crumbs()).toEqual(["This Mac", "parallax", "New thread"]);
});
