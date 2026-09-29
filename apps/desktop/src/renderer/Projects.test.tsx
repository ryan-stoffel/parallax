// @vitest-environment happy-dom
import { act } from "react";
import { createRoot } from "react-dom/client";
import { afterEach, beforeEach, expect, test, vi } from "vite-plus/test";

import type { RpcResponse, SubscriptionMessage, WispBridge } from "../preload/bridge";
import type { Project, Repo } from "../protocol/generated/protocol";
import { App } from "./App";

Object.assign(globalThis, { IS_REACT_ACT_ENVIRONMENT: true });
// happy-dom has no popovers. The Repository menu's options are in the DOM either way.
HTMLElement.prototype.hidePopover = () => {};

const wisp: Repo = {
  id: "r-wisp",
  name: "wisp",
  path: "/src/wisp",
  createdAt: "2026-09-29T09:00:00Z",
};
const project = (name: string, updatedAt: string): Project => ({
  id: `p-${name}`,
  name,
  repoPath: `/src/${name}`,
  branch: "main",
  createdAt: "2026-09-20T12:00:00Z",
  updatedAt,
});
const now = Date.parse("2026-09-29T12:00:00Z");

type Answer = (params: Record<string, unknown>) => RpcResponse<unknown>;
let answers: Record<string, Answer>;
const request = vi.fn(async (_host: string, method: string, params: Record<string, unknown>) => {
  const answer = answers[method];
  return answer ? answer(params) : { error: { code: -32601, message: `${method} isn't faked` } };
});
const pickFolder = vi.fn<() => Promise<string | null>>();
let deliver: (message: SubscriptionMessage) => void;

beforeEach(() => {
  vi.useFakeTimers({ now, toFake: ["Date"] });
  request.mockClear();
  answers = {
    "thread/list": () => ({ result: { repos: [wisp], threads: [], seq: 7 } }),
    "agent/list": () => ({ result: { runs: [], seq: 7 } }),
    "project/list": () => ({
      result: {
        projects: [
          project("ember", "2026-09-26T12:00:00Z"),
          project("photon", "2026-09-29T09:00:00Z"),
        ],
        seq: 7,
      },
    }),
  };
  window.wisp = {
    platform: "darwin",
    setThemeSource: vi.fn(),
    connectionState: async () => ({
      status: "connected",
      wispd: "0.1.0",
      protocol: 1,
      capabilities: {},
    }),
    onConnectionState: () => () => {},
    subscribe: (_host, _params, listener) => {
      deliver = listener;
      return () => {};
    },
    request,
    pickFolder,
    hosts: async () => [],
    onHosts: () => () => {},
  } as Partial<WispBridge> as WispBridge;
});

let unmount = () => {};
afterEach(() => {
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
const click = async (element: Element | null | undefined) => {
  await act(async () => (element as HTMLElement).click());
  await settle();
};
const projectRows = () =>
  [...document.querySelectorAll('[aria-labelledby="projects-heading"] li button')].map(
    (b) => b.textContent,
  );
const crumbs = () =>
  [...document.querySelectorAll('[aria-label="Breadcrumb"] li')].map((li) => li.textContent);
const dialog = () =>
  document.querySelector<HTMLDialogElement>('[aria-labelledby="new-project-title"]')!;
const inDialog = (name: string) =>
  [...dialog().querySelectorAll("button")].find(
    (b) => b.textContent === name || b.getAttribute("aria-label") === name,
  );
const nameBox = () => dialog().querySelector("input")!;
const calls = (method: string) =>
  request.mock.calls.filter(([, m]) => m === method).map(([, , params]) => params);

test("lists wispd's projects, most recently active first, and adds one from project.created", async () => {
  await renderApp();
  expect(projectRows()).toEqual(["photon3h", "ember3d"]);

  await act(async () =>
    deliver({
      type: "event",
      event: {
        subscription: "s-1",
        seq: 8,
        time: "2026-09-29T12:00:00Z",
        event: { kind: "project.created", project: project("wisp", "2026-09-29T12:00:00Z") },
      },
    }),
  );
  expect(projectRows()).toEqual(["wispnow", "photon3h", "ember3d"]);
});

test("a Project is one row that opens its chat: its repository and branch, with the composer off", async () => {
  await renderApp();
  const row = [...document.querySelectorAll("#sidebar li button")].find(
    (b) => b.textContent === "ember3d",
  );
  await click(row);
  expect(crumbs()).toEqual(["This Mac", "ember"]);
  expect(row?.getAttribute("aria-current")).toBe("page");
  const main = document.querySelector("main")!;
  expect(main.querySelector("h2")?.textContent).toBe("ember");
  expect(main.textContent).toContain("/src/ember");
  expect(main.textContent).toContain("main");
  expect(main.querySelector("textarea")!.placeholder).toBe(
    "Chatting with a Project's coordinator isn't available yet",
  );
  expect(main.querySelector<HTMLButtonElement>('button[aria-label="Send"]')!.disabled).toBe(true);
});

test("Create Project names it after its repository, shows wispd's error, retries with the same id, then opens it", async () => {
  answers["project/create"] = () => ({
    error: {
      code: -32000,
      message: "/src/wisp is not the top folder of a git repository: it has no .git.",
      data: { kind: "notARepository" },
    },
  });
  await renderApp();
  await click(document.querySelector('#sidebar button[aria-label="New project"]'));
  expect(dialog().open).toBe(true);
  expect(nameBox().value).toBe("wisp");
  // The coordinator's model is picked per message (RYA-46), not here.
  expect(dialog().querySelector('[aria-label^="Model"]')).toBeNull();

  await click(inDialog("Create Project"));
  expect(dialog().querySelector('[role="alert"]')?.textContent).toBe(
    "/src/wisp is not the top folder of a git repository: it has no .git.",
  );
  expect(dialog().open).toBe(true);

  answers["project/create"] = (p) => ({
    result: { project: { ...project("wisp", "2026-09-29T12:00:00Z"), id: p["id"] } },
  });
  await click(inDialog("Create Project"));
  const [first, retry] = calls("project/create");
  expect(first).toEqual({
    id: expect.stringMatching(/^[0-9a-f]{8}-[0-9a-f]{4}-7/),
    name: "wisp",
    repoPath: "/src/wisp",
  });
  expect(retry).toEqual(first);
  expect(dialog().open).toBe(false);
  expect(crumbs()).toEqual(["This Mac", "wisp"]);
  expect(projectRows()[0]).toBe("wispnow");
});

test("Add repository… in Create Project adds a folder and names the project after it until one is typed", async () => {
  pickFolder.mockResolvedValue("/src/other");
  answers["repo/add"] = (p) => ({
    result: { repo: { ...wisp, id: p["id"], name: "other", path: "/src/other" } },
  });
  answers["project/create"] = (p) => ({
    result: { project: { ...project("Other work", "2026-09-29T12:00:00Z"), id: p["id"] } },
  });
  await renderApp();
  await click(document.querySelector('#sidebar button[aria-label="New project"]'));
  await click(
    [...dialog().querySelectorAll('[role="menuitemradio"]')].find(
      (b) => b.textContent === "Add repository…",
    ),
  );
  expect(calls("repo/add")).toEqual([{ id: expect.any(String), path: "/src/other" }]);
  expect(inDialog("Repository: other")).toBeDefined();
  expect(nameBox().value).toBe("other");

  act(() => {
    Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, "value")!.set!.call(
      nameBox(),
      "Other work",
    );
    nameBox().dispatchEvent(new Event("input", { bubbles: true }));
  });
  await click(inDialog("Create Project"));
  expect(calls("project/create")).toEqual([
    { id: expect.any(String), name: "Other work", repoPath: "/src/other" },
  ]);
});
