// @vitest-environment happy-dom
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, expect, test, vi } from "vite-plus/test";

import type { ParallaxBridge } from "../preload/bridge";
import type { AgentBackgroundTask } from "../protocol/generated/protocol";
import { Notifications } from "./notifications";
import { presentWaiting, WaitingBar } from "./WaitingBar";

Object.assign(globalThis, { IS_REACT_ACT_ENVIRONMENT: true });
// happy-dom has no popovers.
HTMLElement.prototype.showPopover = () => {};
let root: Root | undefined;
afterEach(() => {
  // Notifications outlive a render, so close this test's.
  for (const close of document.querySelectorAll<HTMLButtonElement>(
    '[aria-label="Notifications"] button[aria-label="Close"]',
  ))
    act(() => close.click());
  act(() => root?.unmount());
  root = undefined;
  document.body.innerHTML = "";
});

/** The newest notification's title and body. */
const notice = () => {
  const n = document.querySelector('[aria-label="Notifications"] > div');
  return n && [n.querySelector("span")?.textContent, n.querySelector("p")?.textContent];
};

const url = "https://github.com/o/r/pull/750";
const task = (kind: AgentBackgroundTask["kind"], description: string, taskId = description) => ({
  taskId,
  kind,
  description,
});

// The titles T3 Code's `presentPendingBackgroundWork` gives, with watched pull requests as
// Monitoring.
test("names what the thread waits on as T3 Code does", () => {
  const title = (tasks: AgentBackgroundTask[], urls: string[] = []) =>
    presentWaiting(tasks, urls)?.title;
  expect(title([])).toBeUndefined();
  expect(title([task("agent", "Review src/math.ts")])).toBe(
    "Waiting on subagent Review src/math.ts",
  );
  expect(title([task("monitor", "Watching CI")])).toBe("Watching CI");
  expect(title([task("monitor", "")])).toBe("Waiting on a monitor");
  expect(title([], [url])).toBe("Monitoring pull request #750");
  expect(title([], [url, `${url}1`])).toBe("Monitoring 2 pull requests");
  expect(presentWaiting([task("command", "npm run dev")], [])).toEqual({
    title: "Running: npm run dev",
    items: [{ kind: "command", label: "npm run dev" }],
  });
  expect(
    presentWaiting([task("monitor", "Watching CI"), task("command", "npm run dev")], [url]),
  ).toEqual({
    title: "Waiting on 1 command, 1 monitor and 1 pull request",
    labels: "npm run dev, Watching CI, #750",
    items: [
      { kind: "command", label: "npm run dev" },
      { kind: "monitor", label: "Watching CI" },
      { kind: "pull request", label: "#750" },
    ],
  });
});

test("Stop ends every task and watch through plxd, and shows why one couldn't", async () => {
  const request = vi.fn(async (_host: string, method: string) =>
    method === "pr/unwatch"
      ? { error: { code: -32602, message: "plxd refused" } }
      : { result: {}, logId: "log" },
  );
  window.parallax = { request } as Partial<ParallaxBridge> as ParallaxBridge;
  root = createRoot(document.body.appendChild(document.createElement("div")));
  act(() =>
    root!.render(
      <>
        <WaitingBar
          hostId="local"
          runId="run"
          background={[task("monitor", "gh pr checks 750 --watch", "t1")]}
          watching={[url]}
        />
        <Notifications />
      </>,
    ),
  );
  expect(document.querySelector("section > div")?.textContent).toBe(
    "Waiting on 1 monitor and 1 pull requestgh pr checks 750 --watch, #750Stop",
  );
  // Details lists each item by kind.
  expect(document.querySelector('[role="dialog"] ul')?.textContent).toBe(
    "monitorgh pr checks 750 --watchpull request#750",
  );
  await act(async () => [...document.querySelectorAll("button")].at(-1)!.click());
  expect(request).toHaveBeenCalledWith("local", "agent/stopTask", { runId: "run", taskId: "t1" });
  expect(request).toHaveBeenCalledWith("local", "pr/unwatch", { runId: "run", url });
  expect(notice()).toEqual(["Couldn't stop waiting", "plxd refused"]);
});
