// @vitest-environment happy-dom
import { act } from "react";
import { createRoot } from "react-dom/client";
import { afterEach, beforeEach, expect, test, vi } from "vite-plus/test";

import type { ParallaxBridge } from "../preload/bridge";
import type { PullRequest } from "../protocol/generated/protocol";
import { SidePanel } from "./SidePanel";

Object.assign(globalThis, { IS_REACT_ACT_ENVIRONMENT: true });

const now = Date.parse("2026-09-29T12:00:00Z");
beforeEach(() => {
  vi.useFakeTimers({ now, toFake: ["Date"] });
  window.parallax = { platform: "darwin" } as Partial<ParallaxBridge> as ParallaxBridge;
});

let unmount = () => {};
afterEach(() => {
  act(() => unmount());
  vi.useRealTimers();
});

async function render(onClose = () => {}) {
  const root = createRoot(document.body.appendChild(document.createElement("div")));
  act(() =>
    root.render(
      <SidePanel scope="t" open onClose={onClose} expanded={false} onExpandedChange={() => {}} />,
    ),
  );
  unmount = () => {
    root.unmount();
    document.body.innerHTML = "";
  };
  await settle();
}
const settle = async () => {
  for (let i = 0; i < 10; i++) await act(async () => {});
};
const click = async (element: Element | null | undefined) => {
  await act(async () => (element as HTMLElement).click());
  await settle();
};
const panel = () => document.getElementById("side-panel")!;
const listButton = (name: string) =>
  [...panel().querySelectorAll("nav button")].find((b) => b.textContent?.startsWith(name));
// Each open view's tab, the shown one marked *.
const tabs = () =>
  [...panel().querySelectorAll('[aria-label="Open views"] button[id]')].map(
    (t) => `${t.textContent}${t.getAttribute("aria-current") === "true" ? "*" : ""}`,
  );
const tab = (key: string) => panel().querySelector<HTMLElement>(`#side-panel-tab-${key}`);
const openAView = () => panel().querySelector<HTMLElement>('button[aria-label="Open a view"]');
const shown = () => panel().querySelector<HTMLElement>(":scope > div:not(.titlebar):not([hidden])");
const press = (key: string) =>
  act(() => {
    document.activeElement!.dispatchEvent(new KeyboardEvent("keydown", { key, bubbles: true }));
  });
const listShown = () => panel().querySelector("nav") !== null;

test("views open as tabs: + shows the list, a view's letter opens it, and picking an open one focuses its tab", async () => {
  await render();
  expect(tabs()).toEqual([]);
  expect(listShown()).toBe(true);

  await click(listButton("Diff"));
  expect(tabs()).toEqual(["Diff*"]);
  expect(listShown()).toBe(false);
  expect(shown()!.textContent).toContain("No changes yet");

  await click(openAView());
  expect(listShown()).toBe(true);
  openAView()!.focus();
  press("f");
  expect(tabs()).toEqual(["Diff", "Files*"]);
  expect(shown()!.textContent).toContain("No thread open");

  await click(openAView());
  await click(listButton("Diff"));
  expect(tabs()).toEqual(["Diff*", "Files"]);
});

test("closing the shown tab shows its neighbour, and closing the last collapses the panel", async () => {
  const onClose = vi.fn();
  await render(onClose);
  for (const name of ["Diff", "Terminal", "Files"]) {
    await click(listButton(name));
    await click(openAView());
  }
  await click(tab("D"));
  expect(tabs()).toEqual(["Diff*", "Terminal", "Files"]);

  await click(panel().querySelector('button[aria-label="Close Diff"]'));
  expect(tabs()).toEqual(["Terminal*", "Files"]);
  await click(panel().querySelector('button[aria-label="Close Files"]'));
  expect(tabs()).toEqual(["Terminal*"]);
  // Without a folder, Terminal shows its empty state.
  expect(shown()!.textContent).toContain("No folder here");

  expect(onClose).not.toHaveBeenCalled();
  await click(panel().querySelector('button[aria-label="Close Terminal"]'));
  expect(tabs()).toEqual([]);
  expect(onClose).toHaveBeenCalledOnce();
});

test("closing a tab keeps focus in the panel", async () => {
  await render();
  await click(listButton("Diff"));
  await click(openAView());
  await click(listButton("Files"));
  await click(panel().querySelector('button[aria-label="Close Files"]'));
  expect(document.activeElement).toBe(tab("D"));
});

test("normal threads offer only their five views in order, without Browser", async () => {
  await render();
  expect([...panel().querySelectorAll("nav button span")].map((s) => s.textContent)).toEqual([
    "Device",
    "Terminal",
    "Files",
    "Diff",
    "Pull requests",
  ]);
});

test("Projects keep pinned Knowledge and their view list", async () => {
  const root = createRoot(document.body.appendChild(document.createElement("div")));
  act(() =>
    root.render(
      <SidePanel
        scope="project"
        open
        onClose={() => {}}
        expanded={false}
        onExpandedChange={() => {}}
        project={{ home: <p>Project home</p>, waiting: 0 }}
        knowledge={<p>Project knowledge</p>}
      />,
    ),
  );
  unmount = () => {
    root.unmount();
    document.body.innerHTML = "";
  };
  await settle();
  expect(tabs()).toEqual(["Project*", "Knowledge"]);
  await click(tab("K"));
  expect(shown()!.textContent).toContain("Project knowledge");
  await click(openAView());
  expect(listButton("Knowledge")).toBeDefined();
});

test("opening a Project from the sidebar shows its Project tab, even after Knowledge", async () => {
  const root = createRoot(document.body.appendChild(document.createElement("div")));
  const show = (showProject: object) =>
    act(() =>
      root.render(
        <SidePanel
          scope="project"
          open
          onClose={() => {}}
          expanded={false}
          onExpandedChange={() => {}}
          project={{ home: <p>Project home</p>, waiting: 0 }}
          knowledge={<p>Project knowledge</p>}
          showProject={showProject}
        />,
      ),
    );
  unmount = () => {
    root.unmount();
    document.body.innerHTML = "";
  };
  show({});
  await settle();
  await click(tab("K"));
  expect(tabs()).toEqual(["Project", "Knowledge*"]);
  show({});
  await settle();
  expect(tabs()).toEqual(["Project*", "Knowledge"]);
});

test("each thread shows its own last tab again, and pull request tabs are colored by state", async () => {
  const a = "https://github.com/o/r/pull/1";
  const b = "https://github.com/o/r/pull/2";
  const states: Record<string, "open" | "merged"> = { [a]: "open", [b]: "merged" };
  const root = createRoot(document.body.appendChild(document.createElement("div")));
  unmount = () => {
    root.unmount();
    document.body.innerHTML = "";
  };
  // A thread linking `url`, with `pullRequest` asking the panel to open it.
  const thread = async (url: string, pullRequest?: { url?: string }) => {
    const runId = url === a ? "thread-a" : "thread-b";
    act(() =>
      root.render(
        <SidePanel
          scope={runId}
          open
          onClose={() => {}}
          expanded={false}
          onExpandedChange={() => {}}
          pullRequests={{
            urls: [url],
            get: (u) => ({ pr: { state: states[u] } as PullRequest }),
            list: null,
            view: (u) => <p>{u}</p>,
          }}
          pullRequest={pullRequest}
          documents={{ runId, view: () => null }}
        />,
      ),
    );
    await settle();
  };
  await thread(a);
  await thread(a, { url: a });
  expect(tabs()).toEqual(["#1*"]);
  expect(panel().querySelector('[aria-label="Open views"] svg')!.classList).toContain("text-added");
  await thread(b, { url: b });
  expect(tabs()).toEqual(["#2*"]);
  expect(panel().querySelector('[aria-label="Open views"] svg')!.classList).toContain(
    "text-project-violet",
  );
  await thread(a);
  expect(tabs()).toEqual(["#1*"]);
  expect(shown()!.textContent).toBe(a);
  await thread(b);
  expect(tabs()).toEqual(["#2*"]);
  // A view opened in one thread doesn't open in another (PLX-872).
  await click(openAView());
  await click(listButton("Terminal"));
  expect(tabs()).toEqual(["#2", "Terminal*"]);
  await thread(a);
  expect(tabs()).toEqual(["#1*"]);
  await thread(b);
  expect(tabs()).toEqual(["#2", "Terminal*"]);
});
