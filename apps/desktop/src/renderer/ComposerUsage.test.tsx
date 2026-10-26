// @vitest-environment happy-dom
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, expect, test } from "vite-plus/test";

import { threadUsageOf, UsageRing } from "./ComposerUsage";
import type { RequestUsage } from "./transcript";

Object.assign(globalThis, { IS_REACT_ACT_ENVIRONMENT: true });
let root: Root | undefined;
afterEach(() => {
  act(() => root?.unmount());
  root = undefined;
  document.body.innerHTML = "";
});
const usage: RequestUsage = {
  kind: "requestUsage",
  backend: "claude",
  accountId: "claude",
  at: "2026-10-11T00:00:00Z",
  usage: {
    model: "claude-opus-5-5",
    contextTokens: 50_000,
    contextWindow: 200_000,
    inputTokens: 50_000,
    cachedInputTokens: 25_000,
    outputTokens: 1_780,
    outputMs: 21_513,
  },
};
/** What the ring says, without its "Usage: " prefix, or nothing when it's hidden. */
const line = () =>
  document
    .querySelector("button[aria-expanded]")
    ?.getAttribute("aria-label")
    ?.replace(/^Usage: /, "");
const render = async (
  options: Partial<{
    backend: string;
    accountId: string;
    measured: RequestUsage;
    connected: boolean;
  }> = {},
) => {
  const { backend = "claude", accountId = backend, measured = usage, connected = true } = options;
  root ??= createRoot(document.body.appendChild(document.createElement("div")));
  const data = threadUsageOf({ connected, backend, accountId, kind: backend, usage: measured });
  await act(async () => root!.render(data ? <UsageRing data={data} /> : null));
};

test("another provider or account, or a disconnect, can't show this request's measurements", async () => {
  await render({ backend: "codex" });
  expect(line()).toBeUndefined();
  await render({ accountId: "key-account" });
  expect(line()).toBeUndefined();
  await render({ connected: false });
  expect(line()).toBeUndefined();
  await render({ accountId: "key-account", measured: { ...usage, accountId: "key-account" } });
  expect(line()).toBe("25% of context used");
});
