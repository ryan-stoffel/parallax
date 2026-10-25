// @vitest-environment happy-dom
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, expect, test, vi } from "vite-plus/test";

import { threadUsageOf, tokenPercent, tokensPerSecond, UsageRing } from "./ComposerUsage";
import type { RequestUsage, ThreadUsage } from "./transcript";

Object.assign(globalThis, { IS_REACT_ACT_ENVIRONMENT: true });
const now = Date.parse("2026-10-11T00:00:00Z");
let root: Root | undefined;
afterEach(() => {
  act(() => root?.unmount());
  root = undefined;
  document.body.innerHTML = "";
  vi.useRealTimers();
});
const usage: RequestUsage = {
  kind: "requestUsage",
  backend: "claude",
  accountId: "claude",
  at: new Date(now).toISOString(),
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
const totals: ThreadUsage = {
  inputTokens: 10_000,
  outputTokens: 4_200,
  cacheReadTokens: 900_000,
  cacheWriteTokens: 90_000,
  costUsdMicros: 1_234_000,
  fromStart: true,
};
/** What the ring says, without its "Usage: " prefix, or nothing when it's hidden. */
const line = () =>
  document
    .querySelector("button[aria-expanded]")
    ?.getAttribute("aria-label")
    ?.replace(/^Usage: /, "");
const card = () => document.querySelector<HTMLElement>('[role="group"][aria-label="Usage"]')!;
const render = async (
  options: Partial<{
    backend: string;
    accountId: string;
    measured: RequestUsage | null;
    connected: boolean;
    thread: ThreadUsage;
  }> = {},
) => {
  const { backend = "claude", accountId = backend, measured = usage, connected = true } = options;
  root ??= createRoot(document.body.appendChild(document.createElement("div")));
  const data = threadUsageOf({
    connected,
    backend,
    accountId,
    kind: backend,
    usage: measured ?? undefined,
    totals: options.thread,
  });
  await act(async () => root!.render(data ? <UsageRing data={data} /> : null));
};

test("token ratios validate denominators and preserve zero and tiny percentages", () => {
  expect(tokenPercent(0, 100)).toBe("0%");
  expect(tokenPercent(1, 1000)).toBe("<1%");
  expect(tokenPercent(36458, 36809)).toBe("99%");
  for (const [a, b] of [
    [undefined, 100],
    [0, 0],
    [-1, 100],
    [101, 100],
    [NaN, 100],
  ])
    expect(tokenPercent(a, b)).toBeUndefined();
});

test("the ring fills with the thread's context, and its card shows the thread's usage, no account limits", async () => {
  await render({ thread: totals });
  expect(line()).toBe("25% of context used");
  const text = card().textContent;
  expect(text).toContain("Context50K / 200K · 25%");
  expect(text).toContain("Cache hit50%");
  expect(text).toContain("~83 tok/s");
  expect(text).toContain("Tokens1M in · 4.2K out");
  expect(text).toContain("API cost$1.23");
  // Each row says what it measures, the totals with their input split by cache.
  const tokens = [...card().querySelectorAll("[title]")].find((row) =>
    row.textContent?.startsWith("Tokens"),
  );
  expect(tokens?.getAttribute("title")).toContain("900,000 read from cache");
  expect(text).not.toMatch(/5h|Week|limit/i);
});

test("totals missing earlier turns read as lower bounds, and an unreported cost isn't shown", async () => {
  await render({
    measured: null,
    thread: { ...totals, costUsdMicros: undefined, fromStart: false },
  });
  // No context yet: the ring stays empty but still opens the thread's totals.
  expect(line()).toBe("1M in, 4.2K out this thread");
  expect(card().textContent).toContain("Tokens1M+ in · 4.2K+ out");
  expect(card().textContent).not.toContain("API cost");
});

test("nearly full context changes tone", async () => {
  await render({ measured: { ...usage, usage: { ...usage.usage, contextTokens: 185_000 } } });
  expect(document.querySelector("button[aria-expanded]")!.className).toContain("text-danger");
});

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

test("output speed needs both sides and a provider whose timing it understands", async () => {
  expect(tokensPerSecond(1_780, 21_513)).toBe(83);
  for (const [tokens, ms] of [
    [undefined, 1_000],
    [100, undefined],
    [0, 1_000],
    [100, 0],
    [NaN, 1_000],
  ])
    expect(tokensPerSecond(tokens, ms)).toBeUndefined();
  // A Codex or ACP sample would have no known timing source, so it isn't shown.
  await render({ backend: "codex", measured: { ...usage, backend: "codex", accountId: "codex" } });
  expect(card().textContent).not.toContain("tok/s");
  await render({ measured: { ...usage, usage: { ...usage.usage, outputMs: undefined } } });
  expect(card().textContent).not.toContain("tok/s");
  expect(card().textContent).toContain("Cache hit50%");
});

test("hover peeks at the card, a click keeps it open, and Escape closes it", async () => {
  vi.useFakeTimers();
  await render();
  const item = document.querySelector<HTMLButtonElement>("button[aria-expanded]")!;
  const wrapper = item.parentElement!;
  expect(card().hidden).toBe(true);
  await act(async () => wrapper.dispatchEvent(new MouseEvent("mouseover", { bubbles: true })));
  expect(card().hidden).toBe(false);
  expect(item.getAttribute("aria-expanded")).toBe("true");
  await act(async () => item.click());
  await act(async () => wrapper.dispatchEvent(new MouseEvent("mouseout", { bubbles: true })));
  await act(async () => vi.advanceTimersByTime(200));
  expect(card().hidden).toBe(false);
  await act(async () =>
    item.dispatchEvent(new KeyboardEvent("keydown", { key: "Escape", bubbles: true })),
  );
  expect(card().hidden).toBe(true);
  // Without a click, leaving closes it after the short delay.
  await act(async () => wrapper.dispatchEvent(new MouseEvent("mouseover", { bubbles: true })));
  await act(async () => wrapper.dispatchEvent(new MouseEvent("mouseout", { bubbles: true })));
  await act(async () => vi.advanceTimersByTime(200));
  expect(card().hidden).toBe(true);
});

test("focus leaving closes a card a click kept open", async () => {
  await render();
  const item = document.querySelector<HTMLButtonElement>("button[aria-expanded]")!;
  await act(async () => item.click());
  expect(card().hidden).toBe(false);
  const outside = document.body.appendChild(document.createElement("button"));
  await act(async () =>
    item.dispatchEvent(new FocusEvent("focusout", { bubbles: true, relatedTarget: outside })),
  );
  expect(card().hidden).toBe(true);
});
