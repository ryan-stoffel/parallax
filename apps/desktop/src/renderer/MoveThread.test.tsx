// @vitest-environment happy-dom
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, expect, test, vi } from "vite-plus/test";

import type { ConnectionState, ParallaxBridge } from "../preload/bridge";
import type { Repo } from "../protocol/generated/protocol";
import { MoveThread } from "./MoveThread";

Object.assign(globalThis, { IS_REACT_ACT_ENVIRONMENT: true });

let root: Root | undefined;
afterEach(() => {
  act(() => root?.unmount());
  root = undefined;
  document.body.innerHTML = "";
});

type Answers = Record<string, (host: string, params: Record<string, unknown>) => unknown>;

/** The bridge: `answers` by method, with the saved host `ssh:mini` connected and moving threads. */
function bridge(answers: Answers) {
  const request = vi.fn(async (host: string, method: string, params: Record<string, unknown>) => {
    const answer = answers[method];
    return answer ? answer(host, params) : { error: { code: -32601, message: method } };
  });
  const parallax = {
    connectionState: vi.fn(async (): Promise<ConnectionState> => ({
      status: "connected",
      plxd: "1",
      protocol: 1,
      capabilities: { threadMove: {} },
    })),
    onConnectionState: () => () => {},
    hosts: async () => [{ id: "ssh:mini", name: "Mac mini" }],
    onHosts: (listener: (hosts: unknown[]) => void) => {
      listener([{ id: "ssh:mini", name: "Mac mini" }]);
      return () => {};
    },
    onLocalName: () => () => {},
    onDevices: () => () => {},
    onConnect: () => () => {},
    request,
  };
  window.parallax = parallax as unknown as ParallaxBridge;
  return request;
}

const repo = { id: "r1", name: "parallax", path: "/src/parallax" } as Repo;

const ok = (result: unknown) => () => ({ result });

async function open(props: Partial<Parameters<typeof MoveThread>[0]> = {}) {
  const handlers = { onClose: vi.fn(), onOpen: vi.fn() };
  root = createRoot(document.body.appendChild(document.createElement("div")));
  await act(async () =>
    root!.render(<MoveThread hostId="local" runId="t1" title="Fix it" {...handlers} {...props} />),
  );
  return handlers;
}

const moveHere = async () => {
  await act(() =>
    vi.waitFor(() => expect(document.querySelector("li button:not(:disabled)")).toBeTruthy()),
  );
  await act(async () => document.querySelector<HTMLButtonElement>("li button")!.click());
};

const text = () => document.querySelector("dialog")!.textContent;

test("a thread in a repository pushes its branch, moves onto it there, and is archived here", async () => {
  const exported = { runId: "t1", prompt: "Fix it", backend: "claude", approvals: true };
  const request = bridge({
    "thread/export": ok(exported),
    "agent/gitStatus": ok({ branch: "parallax/fix", changes: 0, ahead: 1, origin: true }),
    "repo/remote": ok({ url: "git@github.com:me/parallax.git" }),
    "agent/push": ok({}),
    "repo/match": ok({ repo: { id: "r9" } }),
    "repo/fetchBase": ok({ commit: "abc" }),
    "thread/receive": ok({ thread: { id: "t9" } }),
    "thread/archive": ok({ thread: { id: "t1" } }),
  });
  const { onOpen } = await open({ repo });
  await moveHere();
  await act(() => vi.waitFor(() => expect(text()).toContain("Moved to Mac mini")));
  expect(request.mock.calls.map(([host, method, params]) => [host, method, params])).toEqual([
    ["local", "thread/export", { runId: "t1" }],
    ["local", "agent/gitStatus", { runId: "t1" }],
    ["local", "repo/remote", { repo: "r1" }],
    ["ssh:mini", "repo/match", { origin: "git@github.com:me/parallax.git" }],
    ["local", "agent/push", { runId: "t1" }],
    ["local", "repo/fetchBase", { repo: "r1", base: "refs/heads/parallax/fix" }],
    ["ssh:mini", "repo/fetchBase", { repo: "r9", base: "origin/parallax/fix" }],
    ["ssh:mini", "thread/receive", { thread: exported, repo: "r9", base: "origin/parallax/fix" }],
    ["local", "thread/archive", { runId: "t1", archived: true }],
  ]);
  await act(async () =>
    [...document.querySelectorAll("button")].find((b) => b.textContent === "Open thread")!.click(),
  );
  expect(onOpen).toHaveBeenCalledWith("ssh:mini", "t9");
});

test("uncommitted changes stop the move before anything leaves this computer", async () => {
  const request = bridge({
    "thread/export": ok({ runId: "t1", prompt: "Fix it", backend: "claude", approvals: true }),
    "agent/gitStatus": ok({ branch: "parallax/fix", changes: 2, ahead: 0, origin: true }),
  });
  await open({ repo });
  await moveHere();
  await act(() => vi.waitFor(() => expect(text()).toContain("uncommitted changes")));
  const methods = request.mock.calls.map(([, method]) => method);
  expect(methods).not.toContain("agent/push");
  expect(methods).not.toContain("thread/receive");
  expect(methods).not.toContain("thread/archive");
});

test("a fetch that leaves the other computer on an older commit stops the move", async () => {
  const request = bridge({
    "thread/export": ok({ runId: "t1", prompt: "Fix it", backend: "claude", approvals: true }),
    "agent/gitStatus": ok({ branch: "parallax/fix", changes: 0, ahead: 1, origin: true }),
    "repo/remote": ok({ url: "git@github.com:me/parallax.git" }),
    "agent/push": ok({}),
    "repo/match": ok({ repo: { id: "r9" } }),
    // Offline, the other computer's fetch keeps what it fetched last.
    "repo/fetchBase": (host) => ({ result: { commit: host === "local" ? "new" : "old" } }),
  });
  await open({ repo });
  await moveHere();
  await act(() => vi.waitFor(() => expect(text()).toContain("Mac mini couldn't fetch")));
  const methods = request.mock.calls.map(([, method]) => method);
  expect(methods).not.toContain("thread/receive");
  expect(methods).not.toContain("thread/archive");
});

test("a thread with no repo moves only its conversation", async () => {
  const request = bridge({
    "thread/export": ok({ runId: "t1", prompt: "Hi", backend: "claude", approvals: true }),
    "thread/receive": ok({ thread: { id: "t9" } }),
    "thread/archive": ok({ thread: { id: "t1" } }),
  });
  await open({ repo: { ...repo, scratch: true } });
  await moveHere();
  await act(() => vi.waitFor(() => expect(text()).toContain("Moved to Mac mini")));
  expect(request.mock.calls.map(([, method]) => method)).toEqual([
    "thread/export",
    "thread/receive",
    "thread/archive",
  ]);
});
