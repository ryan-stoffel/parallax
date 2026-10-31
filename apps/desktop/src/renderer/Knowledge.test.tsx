// @vitest-environment happy-dom
import { act } from "react";
import { createRoot } from "react-dom/client";
import { afterEach, expect, test, vi } from "vite-plus/test";

import type { ParallaxBridge } from "../preload/bridge";
import type { AgentRun, ProviderInfo } from "../protocol/generated/protocol";
import { KnowledgePanel } from "./Knowledge";
import { changeMessage } from "./MemoryPanel";
import { Notifications } from "./notifications";

Object.assign(globalThis, { IS_REACT_ACT_ENVIRONMENT: true });
// happy-dom has no popovers.
HTMLElement.prototype.showPopover = () => {};
HTMLElement.prototype.hidePopover = () => {};

const orchestratorRun: AgentRun = {
  id: "c-1",
  project: "p-1",
  prompt: "Plan it",
  policy: "noWrite",
  status: "running",
  backend: "claude",
  accountId: "claude",
  model: "claude-opus-5-5",
  createdAt: "2026-10-04T10:00:00Z",
  updatedAt: "2026-10-04T10:00:00Z",
};
/** A provider plxd lists, which runs an orchestrator. */
const provider = (id: "claude" | "codex", name: string): ProviderInfo =>
  ({
    instance: { id, kind: id, name, enabled: true, args: [], env: [], models: [] },
    installed: true,
    models: [],
    permissions: ["auto", "bypass"],
    efforts: true,
    orchestrator: true,
  }) as ProviderInfo;
const request = vi.fn(async (_host: string, method: string, _params?: unknown) => {
  const ok = (result: unknown) => ({ logId: "log-1", result });
  if (method === "agent/list") return ok({ runs: [], seq: 1 });
  if (method === "memory/list" || method === "context/list") return ok({ files: [] });
  if (method === "providers/list")
    return ok({ providers: [provider("claude", "Claude"), provider("codex", "Codex")] });
  return ok({ run: orchestratorRun });
});

let unmount = () => {};
afterEach(() => {
  // Notifications outlive a render, so close this test's.
  for (const close of document.querySelectorAll<HTMLButtonElement>(
    '[aria-label="Notifications"] button[aria-label="Close"]',
  ))
    act(() => close.click());
  act(() => unmount());
});

const settle = async () => {
  for (let i = 0; i < 10; i++) await act(async () => {});
};
const click = async (element: Element | null | undefined) => {
  await act(async () => (element as HTMLElement).click());
  await settle();
};
const sends = () => request.mock.calls.filter(([, m]) => m === "agent/send").map(([, , p]) => p);
async function typeChange(text: string) {
  const box = document.querySelector<HTMLTextAreaElement>(
    'textarea[aria-label="Change knowledge"]',
  )!;
  act(() => {
    Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype, "value")!.set!.call(box, text);
    box.dispatchEvent(new Event("input", { bubbles: true }));
  });
  await act(async () => {
    box.dispatchEvent(new KeyboardEvent("keydown", { key: "Enter", bubbles: true }));
  });
  await settle();
}

test("the mini prompt sends a change to the orchestrator, and a model on another provider moves it there", async () => {
  window.parallax = {
    platform: "darwin",
    request,
    subscribe: () => () => {},
    connectionState: async () => ({
      status: "connected",
      plxd: "0.1.0",
      protocol: 1,
      capabilities: { memory: {}, providers: {}, sendModel: {}, sendAccount: {} },
    }),
    onConnectionState: () => () => {},
  } as Partial<ParallaxBridge> as ParallaxBridge;
  const root = createRoot(document.body.appendChild(document.createElement("div")));
  act(() =>
    root.render(
      <>
        <Notifications />
        <KnowledgePanel
          hostId="h-prompt"
          orchestrator="p-1"
          repo="r-1"
          orchestratorRun={orchestratorRun}
          memory
          expanded={false}
        />
      </>,
    ),
  );
  unmount = () => {
    root.unmount();
    document.body.innerHTML = "";
  };
  await settle();

  await typeChange("We moved off Jest, use Vitest");
  expect(sends()).toEqual([
    {
      runId: "c-1",
      turnId: expect.any(String),
      text: changeMessage("We moved off Jest, use Vitest"),
    },
  ]);

  // The picker shows the orchestrator's providers as tabs.
  const tabs = [...document.querySelectorAll('[role="tablist"][aria-label="Provider"] button')];
  await click(tabs[1]);
  await click(document.querySelector<HTMLElement>('[role="listbox"] [role="option"]'));
  await typeChange("Forget the old API notes");
  expect(sends()[1]).toMatchObject({
    runId: "c-1",
    model: expect.any(String),
    account: { kind: "subscription", backend: "codex" },
  });
});
