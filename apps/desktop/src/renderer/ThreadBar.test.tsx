// @vitest-environment happy-dom
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, expect, test, vi } from "vite-plus/test";

import samples from "../../../../crates/parallax-protocol/samples/v1/agents.json";
import type { ParallaxBridge } from "../preload/bridge";
import type { AgentRun, LoggedEvent } from "../protocol/generated/protocol";
import { localId, type Host } from "./hosts";
import { ThreadBar } from "./ThreadBar";

Object.assign(globalThis, { IS_REACT_ACT_ENVIRONMENT: true });
let root: Root | undefined;
afterEach(() => {
  act(() => root?.unmount());
  root = undefined;
  document.body.innerHTML = "";
});

const started = (
  (samples as { method?: string; params?: unknown }[])
    .filter((m) => m.method === "events/event")
    .map((m) => m.params as LoggedEvent)[0]!.event as { run: AgentRun }
).run;
const run: AgentRun = {
  ...started,
  status: "completed",
  branch: "parallax/readme",
  diff: { commit: "abc", files: 1, insertions: 1, deletions: 0 },
};
const host = { id: localId, name: "macbook" } as Host;
const render = (props: { run: AgentRun; canOpenPr: boolean; onPrOpened?: (url: string) => void }) =>
  act(() => {
    root ??= createRoot(document.body.appendChild(document.createElement("div")));
    root.render(
      <ThreadBar
        hostId={localId}
        host={host}
        title="Add a README"
        onPrOpened={() => {}}
        {...props}
      />,
    );
  });

test("it names where the thread runs and its branch, then links its pull requests", () => {
  const url = "https://github.com/acme/web/pull/41";
  render({ run: { ...run, pullRequests: [url] }, canOpenPr: true });
  const text = document.body.textContent;
  expect(text).toContain("macbook·Worktree");
  expect(text).toContain("parallax/readme");
  expect(document.querySelector(`a[href="${url}"]`)?.textContent).toContain("#41");
  // A thread with a pull request has no Create PR.
  expect(document.body.textContent).not.toContain("Create PR");
});

test("Create PR opens one titled like the thread and hands it on", async () => {
  const url = "https://github.com/acme/web/pull/42";
  const request = vi.fn(async () => ({ result: { url } }));
  window.parallax = { request } as unknown as ParallaxBridge;
  const onPrOpened = vi.fn();
  render({ run, canOpenPr: true, onPrOpened });
  const create = [...document.querySelectorAll("button")].find(
    (b) => b.textContent === "Create PR",
  )!;
  await act(async () => create.click());
  expect(request).toHaveBeenCalledExactlyOnceWith(localId, "agent/openPr", {
    runId: run.id,
    title: "Add a README",
  });
  expect(onPrOpened).toHaveBeenCalledExactlyOnceWith(url);
  render({ run, canOpenPr: false });
  expect(document.body.textContent).not.toContain("Create PR");
});
