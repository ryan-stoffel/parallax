// @vitest-environment happy-dom
import type { TiptapEditorHTMLElement } from "@tiptap/react";
import { act } from "react";
import { createRoot } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, test, vi } from "vite-plus/test";

import type { RpcResponse, ParallaxBridge } from "../preload/bridge";
import type { Capabilities, ErrorKind, Repo, Thread } from "../protocol/generated/protocol";
import { accessDefaults, accessPrefs } from "./accessPrefs";
import { App } from "./App";
import { flushToasts } from "./undo";
import { drafts, threadDrafts } from "./drafts";
import { dragThread } from "./threadDrag";
import { fakeWatch } from "./fakeWatch";
import { newThreadDefaults, newThreadPrefs } from "./prefs";
import { sectionsStore } from "./Sidebar";

Object.assign(globalThis, { IS_REACT_ACT_ENVIRONMENT: true });
// happy-dom has no popovers. `openRowMenus` sends the rows' menus the event a browser sends as one
// opens, which renders their items.
HTMLElement.prototype.hidePopover = () => {};
HTMLElement.prototype.showPopover = () => {};
// The composer's image reads, so a test can wait for them: happy-dom reads a file on two chained
// timers, which a fixed wait races when the event loop stalls (PLX-277).
const reads = vi.hoisted(() => [] as Promise<unknown>[]);
vi.mock(import("./images"), async (importOriginal) => {
  const images = await importOriginal();
  return {
    ...images,
    readImage: (...args) => {
      const read = images.readImage(...args);
      reads.push(read);
      return read;
    },
  };
});
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

beforeEach(() => {
  request.mockClear();
  capabilities = {};
  localStorage.clear();
  // Working starts folded (0075); these tests read the rows in it.
  sectionsStore.set({ all: { working: true } });
  accessPrefs.set(accessDefaults);
  newThreadPrefs.set(newThreadDefaults);
  // A test that ends with text in New Thread leaves it as a draft.
  for (const d of drafts.get()) drafts.remove(d.id);
  for (const key of Object.keys(threadDrafts.get())) threadDrafts.remove(key);
  answers = {
    "thread/list": () => ({ result: { repos: [parallax], threads: [thread], seq: 7 } }),
    "agent/list": () => ({
      result: { runs: [run(thread.id, "Fix the flaky test\nPlease.")], seq: 7 },
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
    onHostUpdate: () => () => {},
    watch: fakeWatch(() => window.parallax),
    subscribe: () => () => {},
    request,
    pickFolder,
    hosts: async () => [],
    onHosts: () => () => {},
    onConnect: () => () => {},
    onDevices: () => () => {},
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
  // Notifications outlive a render, so close this test's.
  for (const close of document.querySelectorAll<HTMLButtonElement>(
    '[aria-label="Notifications"] button[aria-label="Close"]',
  ))
    act(() => close.click());
  act(() => unmount());
  vi.useRealTimers();
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
const button = (name: string) =>
  [...document.querySelectorAll("button")].find(
    (b) => b.textContent === name || b.getAttribute("aria-label") === name,
  );
// A thread's row, by its title.
const threadRow = (title: string) =>
  [...document.querySelectorAll('#sidebar li[data-kind="thread"] > button:first-child')].find((b) =>
    b.querySelector("[data-title]")?.textContent?.startsWith(title),
  );
const openRowMenus = () =>
  act(() => {
    for (const menu of document.querySelectorAll('#sidebar li[data-kind="thread"] [role="menu"]'))
      menu.dispatchEvent(Object.assign(new Event("beforetoggle"), { newState: "open" }));
  });
const calls = (method: string) =>
  request.mock.calls.filter(([, m]) => m === method).map(([, , params]) => params);
const heading = () => document.querySelector("h1")?.textContent;
/** The newest notification's title and body. */
const notice = () => {
  const toast = document.querySelector('[aria-label="Notifications"] > div');
  return toast && [toast.querySelector("span")?.textContent, toast.querySelector("p")?.textContent];
};
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

/** Sends `text` in place of what the box holds, or without one, what it holds. */
async function send(text?: string) {
  const box = composer();
  if (text !== undefined) act(() => void box.editor!.commands.setContent(text));
  await act(async () => {
    box.dispatchEvent(new KeyboardEvent("keydown", { key: "Enter", bubbles: true }));
  });
  await settle();
}

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
  expect(notice()?.[1]).toBe("plxd is busy");
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
    branchSlug: "tidy-the-readme",
  });
  expect(retry).toEqual(first);
  // The thread opens, and its row is in the sidebar under its repository.
  expect(crumbs()).toEqual(["This Mac", "other", "Tidy the README"]);
  expect(threadRow("Tidy the README")?.getAttribute("aria-current")).toBe("page");
});

// The transcript's message bubble, and the musing under it until the agent does anything.
const bubble = () => document.querySelector('[role="log"] .bg-selected')?.textContent;
const musing = () =>
  [...document.querySelectorAll('[role="log"] [data-slot=trace-line][data-status=running]')].find(
    (line) => !line.closest("summary"),
  )?.textContent;

test("Send shows the prompt at once while plxd starts the thread, and a failure puts it back", async () => {
  let answer: (response: RpcResponse<unknown>) => void = () => {};
  answers["thread/start"] = () =>
    new Promise((resolve) => (answer = resolve)) as unknown as RpcResponse<unknown>;
  await renderApp();
  await send("Tidy the README");
  expect(heading()).toBeUndefined();
  expect(bubble()).toBe("Tidy the README");
  expect(document.querySelector('[role="log"] .bg-selected')!.className).not.toContain("opacity");
  expect(musing()).toBe("Working");
  // The box looks as it did, and a send meanwhile stays in it.
  expect(composer().getAttribute("aria-placeholder")).toBe(
    "Build a feature, fix a bug, paste an image, use /skills, @files or threads",
  );
  expect(control("Runs on: This Mac, New worktree")).not.toBeNull();
  await send("And the CHANGELOG");
  expect(composer().textContent).toBe("And the CHANGELOG");
  expect(calls("thread/start")).toHaveLength(1);
  act(() => void composer().editor!.commands.clearContent());

  await act(async () => answer({ error: { code: -32000, message: "plxd is busy" } }));
  await settle();
  expect(heading()).toBe("What should we build in parallax?");
  expect(composer().textContent).toBe("Tidy the README");
  expect(notice()?.[1]).toBe("plxd is busy");
  expect(document.querySelector("[data-status=running]")).toBeNull();
});

test("a finished thread opens on Loading…, not its prompt alone, while its transcript loads", async () => {
  answers["agent/list"] = () => ({
    result: { runs: [run(thread.id, "Fix the flaky test", "completed")], seq: 7 },
  });
  answers["agent/events"] = () => new Promise(() => {}) as unknown as RpcResponse<unknown>;
  await renderApp();
  await act(async () => (threadRow("Fix the flaky test") as HTMLElement).click());
  await settle();
  expect(crumbs()).toEqual(["This Mac", "parallax", "Fix the flaky test"]);
  expect(bubble()).toBeUndefined();
  expect(document.querySelector("main")!.textContent).toContain("Loading…");
  expect(document.querySelector("[data-status=running]")).toBeNull();
  expect(musing()).toBeUndefined();
});

test("leaving New Thread keeps its prompt as a draft atop Threads, which reopens it (PLX-788)", async () => {
  capabilities = { threadContext: { maxThreads: 8 } };
  answers["thread/start"] = (p) => ({
    result: {
      thread: { id: p["runId"], repo: parallax.id, createdAt: "2026-09-26T12:05:00Z" },
      run: run(p["runId"] as string, "Tidy the README"),
    },
  });
  await renderApp();
  const data = new DataTransfer();
  dragThread(data, "local", thread.id);
  act(() => {
    document.querySelector("main form")!.dispatchEvent(
      Object.defineProperty(new Event("drop", { bubbles: true }), "dataTransfer", {
        value: data,
      }),
    );
    void composer().editor!.commands.insertContent("Tidy the README");
  });
  await act(async () => (threadRow("Fix the flaky test") as HTMLElement).click());
  await settle();

  const draft = () => document.querySelector<HTMLElement>('#sidebar li[data-kind="draft"] button');
  const rows = document.querySelectorAll('#sidebar ul[aria-label="Threads"] > li');
  expect(rows[0]!.getAttribute("data-kind")).toBe("draft");
  expect(draft()!.textContent).toBe('parallaxDraft@"Fix the flaky test" Tidy the README');

  await act(async () => draft()!.click());
  await settle();
  expect(draft()).toBeNull();
  expect(heading()).toBe("What should we build in parallax?");
  // With the thread's chip back where it was.
  expect(composer().textContent).toBe("Fix the flaky test Tidy the README");

  // Starting it leaves no draft behind.
  await send();
  expect(calls("thread/start")).toEqual([
    expect.objectContaining({
      prompt: '@"Fix the flaky test" Tidy the README',
      threads: [thread.id],
    }),
  ]);
  expect(draft()).toBeNull();
});

test("leaving a thread keeps its unsent prompt as a draft, which coming back restores (PLX-887)", async () => {
  // Seen and finished, so their rows show no news in place of a draft.
  const seen = {
    repo: parallax.id,
    createdAt: "2026-09-26T12:00:01Z",
    seenAt: "2026-09-26T13:00:00Z",
  };
  const done = (id: string, prompt: string) => ({
    ...run(id, prompt, "completed"),
    updatedAt: "2026-09-26T12:30:00Z",
  });
  answers["thread/list"] = () => ({
    result: {
      repos: [parallax],
      threads: [
        { ...seen, id: "t-1" },
        { ...seen, id: "t-2" },
      ],
      seq: 7,
    },
  });
  answers["agent/list"] = () => ({
    result: { runs: [done("t-1", "Fix the flaky test"), done("t-2", "Tidy the README")], seq: 7 },
  });
  await renderApp();
  // Its Draft status and outline.
  const drafted = (title: string) => {
    const li = threadRow(title)!.closest("li")!;
    const status = li.textContent!.includes("Draft");
    expect(li.className.includes("ring-warning")).toBe(status);
    return status;
  };
  const open = async (title: string) => {
    await act(async () => (threadRow(title) as HTMLElement).click());
    await settle();
  };

  await open("Fix the flaky test");
  act(() => void composer().editor!.commands.setContent("Half a thought"));
  await open("Tidy the README");
  expect(composer().textContent).toBe("");
  expect(drafted("Fix the flaky test")).toBe(true);

  await open("Fix the flaky test");
  expect(composer().textContent).toBe("Half a thought");
  expect(drafted("Fix the flaky test")).toBe(false);

  // An emptied box leaves no draft behind.
  act(() => void composer().editor!.commands.setContent(""));
  await open("Tidy the README");
  expect(drafted("Fix the flaky test")).toBe(false);
});

test("a new thread asks plxd to forward its permission requests only when plxd advertises approvals (PLX-196)", async () => {
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
    expect(control("Access: Auto-accept edits")).not.toBeNull();

    // Plan is a legacy level, so the picker lists it only once Settings turns it on.
    const levels = () =>
      [...document.querySelectorAll('[role="menu"][aria-label="Access"] [role="menuitemradio"]')]
        .map((o) => o.textContent)
        .join("|");
    await act(async () => (control("Access: Auto-accept edits") as HTMLElement).click());
    expect(levels()).not.toContain("Plan");
    await act(async () => (control("Access: Auto-accept edits") as HTMLElement).click());
    act(() => accessPrefs.set({ legacyPlan: true }));
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
    expect(notice()?.[1]).toBe("the claude backend can't run with effort max");
    effort("3");
    await send("Plan the settings split");

    const [refused, retry] = calls("thread/start");
    expect(refused).toEqual({
      runId: expect.any(String),
      repo: parallax.id,
      prompt: "Plan the settings split",
      branchSlug: "plan-the-settings-split",
      model: "claude-fable-5-1",
      effort: "max",
      permission: "plan",
    });
    expect(retry).toEqual({ ...refused, runId: expect.any(String), effort: "xhigh" });
    expect(retry!["runId"]).not.toBe(refused!["runId"]);
  });
});

test("A send while the picked computer adds the repository waits, then starts the thread there (PLX-905)", async () => {
  window.parallax.hosts = async () => [{ id: "ssh-mini", name: "mac mini", destination: "mini" }];
  const added: Repo = { ...parallax, id: "r-mini-parallax" };
  let finish: (answer: RpcResponse<unknown>) => void = () => {};
  request.mockImplementation(async (host, method, params) => {
    if (host === "ssh-mini" && method === "thread/list")
      return { result: { repos: [], threads: [], seq: 1 } };
    if (host === "ssh-mini" && method === "repo/add")
      return new Promise((resolve) => (finish = resolve));
    const answer = answers[method];
    return answer ? answer(params) : { error: { code: -32601, message: `${method} isn't faked` } };
  });
  answers["thread/start"] = (p) => ({
    result: {
      thread: { id: p["runId"], repo: p["repo"], createdAt: "2026-09-26T12:05:00Z" },
      run: run(p["runId"] as string, "Fix it"),
    },
  });
  await renderApp();
  await choose("Runs on", "mac miniSSH · miniClones parallax");
  // Picked at once, with a spinner while it's set up.
  expect(control("Runs on: mac mini, New worktree")?.getAttribute("aria-busy")).toBe("true");
  await send("Fix it");
  // Not on the computer being left.
  expect(calls("thread/start")).toEqual([]);
  await act(async () => finish({ result: { repo: added } }));
  await settle();
  expect(request).toHaveBeenCalledWith(
    "ssh-mini",
    "thread/start",
    expect.objectContaining({ prompt: "Fix it", repo: added.id }),
  );
});

test("Delete asks first, and only deletes once confirmed", async () => {
  answers["thread/delete"] = () => ({ result: {} });
  await renderApp();
  await act(async () => button("Thread actions")!.click());
  openRowMenus();
  await act(async () => button("Delete…")!.click());
  const dialog = [...document.querySelectorAll("dialog")].find((d) =>
    d.querySelector("h2")?.textContent?.startsWith("Delete this"),
  )!;
  expect(dialog.open).toBe(true);
  expect(dialog.textContent).toContain("Fix the flaky test");

  await act(async () => button("Cancel")!.click());
  expect(dialog.open).toBe(false);
  expect(calls("thread/delete")).toEqual([]);

  await act(async () => button("Delete…")!.click());
  await act(async () => button("Delete")!.click());
  await settle();
  // Held back, out of the list, while its toast's Undo can bring it back.
  expect(dialog.open).toBe(false);
  expect(threadRow("Fix the flaky test")).toBeUndefined();
  expect(calls("thread/delete")).toEqual([]);
  await act(async () => button("Undo")!.click());
  expect(threadRow("Fix the flaky test")).toBeDefined();
  expect(calls("thread/delete")).toEqual([]);

  // Once Undo can't take it back, it goes.
  await act(async () => button("Thread actions")!.click());
  openRowMenus();
  await act(async () => button("Delete…")!.click());
  await act(async () => button("Delete")!.click());
  await act(async () => flushToasts());
  await settle();
  expect(calls("thread/delete")).toEqual([{ runId: thread.id }]);
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
});
