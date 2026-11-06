// @vitest-environment happy-dom
import { act, type ReactNode } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, expect, test, vi } from "vite-plus/test";

import type { ConnectionState, ParallaxBridge } from "../../preload/bridge";
import type { Orchestrator } from "../../protocol/generated/protocol";
import { useShownConnection } from "../ConnectionStatus";
import type { ThreadsView } from "../threads";
import { OrchestratorPane } from "./OrchestratorSettings";
import { HostTasks } from "./ScheduleSettings";
import { RepoScripts } from "./ScriptSettings";

Object.assign(globalThis, { IS_REACT_ACT_ENVIRONMENT: true });

// Settings pages through a short drop: the shown state stays connected, and requests fail.
const up: ConnectionState = {
  status: "connected",
  plxd: "1",
  protocol: 1,
  capabilities: { schedules: {}, setupScripts: {}, integrationBranch: {}, repoRefs: {} },
};
const script = { name: "Install", command: "pnpm i", phase: "setup" };
const task = { id: "t", title: "Nightly report", enabled: true, schedule: {} };

let root: Root | undefined;
let hear: (hostId: string, state: ConnectionState) => void;
let down: boolean;
let request: ReturnType<typeof vi.fn>;

beforeEach(() => {
  down = false;
  request = vi.fn(async (_host: string, method: string) => {
    if (down) return { error: { code: -32603, message: "not connected" } };
    if (method === "schedule/list") return { result: { tasks: [task] } };
    if (method === "repo/scripts") return { result: { scripts: [script], fileScripts: [] } };
    if (method === "repo/refs") return { result: { refs: [] } };
    return { result: {} };
  });
  const parallax: Partial<ParallaxBridge> = {
    request: request as never,
    connectionState: async () => up,
    onConnectionState: (listener) => ((hear = listener), () => {}),
  };
  Object.assign(window, { parallax });
  root = createRoot(document.body.appendChild(document.createElement("div")));
});
afterEach(() => {
  act(() => root?.unmount());
  document.body.innerHTML = "";
});

const render = (children: ReactNode) => act(async () => root!.render(children));
const drop = async () => {
  down = true;
  await act(async () => hear("h", { status: "connecting" }));
};
const recover = async () => {
  down = false;
  await act(async () => hear("h", { ...up }));
};
const asked = (method: string) => request.mock.calls.filter(([, m]) => m === method).length;

test("schedules stay on screen through a short drop, and are read again after it", async () => {
  const host = { id: "h", name: "Mac" };
  await render(<HostTasks host={host} named={false} />);
  expect(document.body.textContent).toContain("Nightly report");

  await drop();
  expect(document.body.textContent).toContain("Nightly report");
  expect(document.body.textContent).not.toContain("Loading");

  await recover();
  expect(document.body.textContent).toContain("Nightly report");
  expect(asked("schedule/list")).toBe(2);
});

test("scripts stay on screen through a short drop, and keep unsaved edits after it", async () => {
  await render(<RepoScripts hostId="h" repo={{ id: "r", name: "repo" }} />);
  const name = () => document.querySelector<HTMLInputElement>('input[aria-label="Name"]');
  expect(name()?.value).toBe("Install");
  await act(async () => {
    Reflect.set(HTMLInputElement.prototype, "value", "Install edited", name());
    name()!.dispatchEvent(new Event("input", { bubbles: true }));
  });

  await drop();
  expect(name()?.value).toBe("Install edited");
  expect(document.body.textContent).not.toContain("Loading");

  await recover();
  expect(name()?.value).toBe("Install edited");
  expect(asked("repo/scripts")).toBe(2);
});

test("scripts with no edits take what's read after a short drop", async () => {
  await render(<RepoScripts hostId="h" repo={{ id: "r", name: "repo" }} />);
  await drop();
  request.mockImplementationOnce(async () => ({
    result: { scripts: [{ ...script, name: "Changed elsewhere" }], fileScripts: [] },
  }));
  await recover();
  const name = document.querySelector<HTMLInputElement>('input[aria-label="Name"]');
  expect(name?.value).toBe("Changed elsewhere");
});

test("an orchestrator's branches opened during a short drop are read once it's back", async () => {
  const Keep = () => (useShownConnection("h"), null);
  const pane = (
    <OrchestratorPane
      hostId="h"
      orchestrator={{ id: "o", name: "Docs", repoPath: "/repo" } as unknown as Orchestrator}
      view={{ state: { repos: [{ id: "r", path: "/repo" }] } } as unknown as ThreadsView}
    />
  );
  await render(<Keep />);
  await act(async () => {});
  await drop();
  await render(
    <>
      <Keep />
      {pane}
    </>,
  );
  const whileDown = request.mock.results.length;
  await recover();
  const after = request.mock.calls.slice(whileDown).filter(([, m]) => m === "repo/refs");
  expect(after.length).toBe(1);
});
