// @vitest-environment happy-dom
import { act } from "react";
import { createRoot } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, test, vi } from "vite-plus/test";

import type { RpcResponse, SubscriptionMessage, WispBridge } from "../preload/bridge";
import type { ErrorKind, Repo, Thread } from "../protocol/generated/protocol";
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
    hosts: async () => [],
    onHosts: () => () => {},
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

async function choose(label: string, option: string) {
  const item = [
    ...document.querySelectorAll<HTMLElement>(
      `[role="menu"][aria-label="${label}"] [role="menuitemradio"]`,
    ),
  ].find((b) => b.textContent === option)!;
  await act(async () => item.click());
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

  await choose("Repository", "Add repository…");
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
  await choose("Repository", "No Repo");
  expect(heading()).toBe("What should we work on without a repo?");
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
  await choose("Repository", "Add repository…");
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
    expect(document.querySelector("textarea")!.value).toBe("Tidy the README");

    await act(async () => chooser.querySelectorAll("input")[1]!.click());
    await act(async () => button("Continue")!.click());
    await settle();
    expect(calls("accounts/defaults/set")).toEqual([
      { role: "worker", account: { kind: "key", id: "Work" } },
    ]);
    const [first, retry] = calls("thread/start");
    expect(retry).toEqual(first);
    expect(crumbs()).toEqual(["This Mac", "wisp", "Tidy the README"]);
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
    expect(crumbs()).toEqual(["This Mac", "wisp", "Hi"]);
    expect(document.querySelector("main")!.textContent).toContain(
      "Using Claude Code for new threads on this host.",
    );
  });

  test("shows wispd's error when it can't list accounts", async () => {
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

test("known error kinds read plainly, and unknown ones show wispd's message", async () => {
  const alert = () => document.querySelector('[role="alert"]')?.textContent;
  answers["thread/start"] = () => ({
    error: { code: -32000, message: "no repo entry has id r-9", data: { kind: "repoNotFound" } },
  });
  await renderApp();
  await send("Hi");
  expect(alert()).toBe("That repository isn't in wisp anymore. Choose another one.");

  answers["thread/start"] = () => ({
    // A kind from a newer wispd.
    error: {
      code: -32000,
      message: "wispd is shy today",
      data: { kind: "somethingNew" as ErrorKind },
    },
  });
  await send("Hi");
  expect(alert()).toBe("wispd is shy today");
});

test("an open thread deleted by another client goes back to New Thread", async () => {
  let deliver: (message: SubscriptionMessage) => void = () => {};
  window.wisp.subscribe = (_host, _params, listener) => {
    deliver = listener;
    return () => {};
  };
  await renderApp();
  await act(async () => (threadRow("Fix the flaky test") as HTMLElement).click());
  expect(crumbs()).toEqual(["This Mac", "wisp", "Fix the flaky test"]);

  await act(async () =>
    deliver({
      type: "event",
      event: {
        subscription: "s-1",
        seq: 8,
        time: "2026-09-26T12:06:00Z",
        event: { kind: "thread.deleted", runId: thread.id, repo: wisp.id },
      },
    }),
  );
  await settle();
  expect(crumbs()).toEqual(["This Mac", "wisp", "New thread"]);
});
