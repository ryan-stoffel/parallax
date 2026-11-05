// @vitest-environment happy-dom
import { act } from "react";
import { createRoot } from "react-dom/client";
import { expect, test, vi } from "vite-plus/test";

import type { RpcError } from "../../preload/bridge";
import type { PrFile, PrFileViewed } from "../../protocol/generated/protocol";
import { changedSinceViewed, settledTicks, useViewedFiles, viewedPaths } from "./viewedFiles";

const file = (path: string, viewed?: PrFileViewed): PrFile => ({
  path,
  additions: 1,
  deletions: 0,
  viewed,
});
const url = "https://github.com/o/r/pull/1";

/** Mounts `useViewedFiles`, with `current` its latest answer. */
async function mount(options: Omit<Parameters<typeof useViewedFiles>[0], "url">) {
  const result = {} as { current: ReturnType<typeof useViewedFiles> };
  function Probe() {
    result.current = useViewedFiles({ url, ...options });
    return null;
  }
  (globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
  await act(async () => createRoot(document.createElement("div")).render(<Probe />));
  return result;
}

test("viewed is GitHub's read with the ticks over it", () => {
  const files = [file("a", "viewed"), file("b", "unviewed"), file("c", "viewed")];
  const ticks = new Map([
    ["b", true],
    ["c", false],
  ]);
  expect([...viewedPaths(files, ticks)].sort()).toEqual(["a", "b"]);
});

test("a file changed since it was viewed is unviewed and says so, until it's ticked", () => {
  const files = [file("a", "dismissed")];
  expect(viewedPaths(files, new Map()).has("a")).toBe(false);
  expect(changedSinceViewed(files, new Map()).has("a")).toBe(true);
  expect(changedSinceViewed(files, new Map([["a", true]])).has("a")).toBe(false);
});

test("a tick goes once GitHub's read agrees, and not before", () => {
  const ticks = new Map([["a", true]]);
  expect(settledTicks([file("a", "unviewed")], ticks)).toBe(ticks);
  expect(settledTicks([file("a", "viewed")], ticks).size).toBe(0);
});

test("a tick shows at once and sends the write, with no re-read", async () => {
  const send = vi.fn(async () => undefined);
  const result = await mount({
    files: [file("a", "unviewed")],
    nodeId: "PR_1",
    send,
    onFailed: () => {},
  });
  await act(() => result.current.set("a", true));
  expect(result.current.viewed.has("a")).toBe(true);
  expect(send).toHaveBeenCalledWith({
    kind: "setFileViewed",
    pullRequestId: "PR_1",
    path: "a",
    viewed: true,
  });
});

test("a failed write takes its tick back and says so", async () => {
  const error = { code: 1, message: "nope" } as RpcError;
  const onFailed = vi.fn();
  const result = await mount({
    files: [file("a", "viewed")],
    nodeId: "PR_1",
    send: async () => error,
    onFailed,
  });
  await act(() => result.current.set("a", false));
  expect(result.current.viewed.has("a")).toBe(true);
  expect(onFailed).toHaveBeenCalledWith("a", false, error);
});

test("without a node id, as from an older plxd, ticks stay here", async () => {
  const send = vi.fn(async () => undefined);
  const result = await mount({ files: [file("a")], send, onFailed: () => {} });
  await act(() => result.current.set("a", true));
  expect(send).not.toHaveBeenCalled();
  expect(result.current.viewed.has("a")).toBe(true);
});
