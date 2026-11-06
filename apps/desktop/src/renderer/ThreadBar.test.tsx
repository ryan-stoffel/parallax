// @vitest-environment happy-dom
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, expect, test, vi } from "vite-plus/test";

import samples from "../../../../crates/parallax-protocol/samples/v1/agents.json";
import type { ParallaxBridge } from "../preload/bridge";
import type { AgentRun, LoggedEvent } from "../protocol/generated/protocol";
import { localId, type Host } from "./hosts";
import type { PullRequests } from "./PullRequests";
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
const render = (props: {
  run: AgentRun;
  canOpenPr: boolean;
  onPrOpened?: (url: string) => void;
  onOpenPrs?: () => void;
  prs?: PullRequests;
}) =>
  act(() => {
    root ??= createRoot(document.body.appendChild(document.createElement("div")));
    root.render(
      <ThreadBar
        hostId={localId}
        host={host}
        title="Add a README"
        onPrOpened={() => {}}
        onOpenPrs={() => {}}
        {...props}
      />,
    );
  });

test("it labels the place icons and shows its branch, then its pull request, or how many", () => {
  const url = "https://github.com/acme/web/pull/41";
  render({ run: { ...run, pullRequests: [url] }, canOpenPr: true });
  const text = document.body.textContent;
  expect(text).not.toContain("macbook");
  expect(text).not.toContain("Worktree");
  expect(document.querySelector('[role="img"][aria-label="macbook"]')?.getAttribute("title")).toBe(
    "macbook",
  );
  expect(document.querySelector('[role="img"][aria-label="Worktree"]')?.getAttribute("title")).toBe(
    "Worktree",
  );
  expect(text).toContain("parallax/readme");
  expect(document.querySelector(`a[href="${url}"]`)?.textContent).toBe("#41");
  // A thread with a pull request has no Create PR.
  expect(document.body.textContent).not.toContain("Create PR");

  const onOpenPrs = vi.fn();
  render({
    run: { ...run, pullRequests: [url, "https://github.com/acme/web/pull/43"] },
    canOpenPr: true,
    onOpenPrs,
  });
  expect(document.querySelector("a[href]")).toBeNull();
  const all = document.querySelector<HTMLButtonElement>('[aria-label="2 pull requests"]')!;
  expect(all.title).toBe("#41, #43");
  act(() => all.click());
  expect(onOpenPrs).toHaveBeenCalledOnce();

  render({ run: { ...run, checkout: true }, canOpenPr: false });
  expect(
    document.querySelector('[role="img"][aria-label="Local checkout"]')?.getAttribute("title"),
  ).toBe("Local checkout");
});

test("several pull requests take the color of most of them", () => {
  const urls = [41, 42, 43].map((n) => `https://github.com/acme/web/pull/${n}`);
  const state = { [urls[0]!]: "merged", [urls[1]!]: "open", [urls[2]!]: "merged" };
  const prs = {
    urls,
    get: (url: string) => ({ pr: { state: state[url] } }),
  } as unknown as PullRequests;
  render({ run: { ...run, pullRequests: urls }, canOpenPr: false, prs });
  const count = document.querySelector('[aria-label="3 pull requests"] span')!;
  expect(count.className).toContain("text-project-violet");
  expect(count.textContent).toBe("+2");
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
