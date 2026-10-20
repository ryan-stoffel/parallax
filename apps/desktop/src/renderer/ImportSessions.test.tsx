// @vitest-environment happy-dom
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, expect, test, vi } from "vite-plus/test";

import type { ParallaxBridge } from "../preload/bridge";
import type { ImportableSession } from "../protocol/generated/protocol";
import { ImportSessions } from "./ImportSessions";

Object.assign(globalThis, { IS_REACT_ACT_ENVIRONMENT: true });
let root: Root | undefined;
afterEach(() => {
  act(() => root?.unmount());
  root = undefined;
  document.body.innerHTML = "";
});

const session = (over: Partial<ImportableSession>): ImportableSession => ({
  source: "codex",
  id: "s",
  title: "A session",
  updatedAt: "2026-10-01T00:00:00Z",
  ...over,
});

test("picking an app's sessions imports each on that app's agent, then lists them imported", async () => {
  let sessions = [
    session({ source: "claude", id: "c1", title: "Fix the login redirect", cwd: "/src/web" }),
    session({ id: "x1", title: "Finish HW2" }),
    session({ id: "x2", title: "Zip the submission" }),
    session({ id: "x3", title: "Already here", thread: "01a0" }),
  ];
  const request = vi.fn(async (_host: string, method: string, params: Record<string, unknown>) => {
    if (method === "thread/importable") return { result: { sessions } };
    if (method === "providers/list")
      return {
        result: {
          providers: [
            { instance: { id: "codex", kind: "codex", enabled: true } },
            { instance: { id: "claude", kind: "claude", enabled: false } },
          ],
        },
      };
    if (method === "thread/import") {
      sessions = sessions.map((s) => (s.id === params["id"] ? { ...s, thread: "01a1" } : s));
      return { result: {} };
    }
    throw new Error(`unexpected ${method}`);
  });
  window.parallax = {
    connectionState: async () => ({
      status: "connected" as const,
      plxd: "1",
      protocol: 1,
      capabilities: { threadImport: {} },
    }),
    onConnectionState: () => () => {},
    request,
  } as unknown as ParallaxBridge;
  root = createRoot(document.body.appendChild(document.createElement("div")));
  await act(async () => root!.render(<ImportSessions />));
  const box = (label: string) =>
    document.querySelector<HTMLInputElement>(`input[aria-label="${label}"]`)!;

  expect(document.body.textContent).toContain("1 of 4 imported");
  expect(box("Import Already here")).toBeNull();
  const button = (name: string) =>
    [...document.querySelectorAll("button")].find((b) => b.textContent === name)!;
  await act(async () => box("Codex").click());
  expect(box("Import Fix the login redirect")).toBeNull();
  await act(async () => button("Select all").click());
  expect(box("Import Finish HW2").checked).toBe(true);
  expect(document.body.textContent).toContain("2 selected");
  await act(async () => button("Import 2").click());

  const imports = request.mock.calls.filter(([, method]) => method === "thread/import");
  expect(imports.map(([, , params]) => params)).toEqual([
    { source: "codex", id: "x1", account: { kind: "subscription", backend: "codex" } },
    { source: "codex", id: "x2", account: { kind: "subscription", backend: "codex" } },
  ]);
  expect(document.body.textContent).toContain("3 of 4 imported");
  expect(button("Select all").disabled).toBe(true);
});
