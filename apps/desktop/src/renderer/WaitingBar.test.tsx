// @vitest-environment happy-dom
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, expect, test, vi } from "vite-plus/test";

import type { PullRequest } from "../protocol/generated/protocol";
import type { PullRequests } from "./PullRequests";
import { WaitingBar } from "./WaitingBar";

Object.assign(globalThis, { IS_REACT_ACT_ENVIRONMENT: true });
let root: Root | undefined;
afterEach(() => {
  act(() => root?.unmount());
  root = undefined;
  document.body.innerHTML = "";
});

const merged = "https://github.com/o/r/pull/934";
const unread = "https://github.com/o/r/pull/935";
const prs: PullRequests = {
  urls: [merged, unread],
  get: (url) =>
    url === merged ? { pr: { state: "merged", draft: false } as PullRequest } : undefined,
  refresh: async () => {},
  act: async () => undefined,
};

function render(watching: string[]) {
  root ??= createRoot(document.body.appendChild(document.createElement("div")));
  act(() =>
    root!.render(
      <WaitingBar
        hostId="local"
        runId="run"
        background={[]}
        watching={watching}
        pullRequests={prs}
      />,
    ),
  );
}

const chip = (n: number) =>
  [...document.querySelectorAll<HTMLAnchorElement>("a")].find((a) => a.textContent === `#${n}`);

test("a watched pull request's number is a link in its state's color, beside GitHub's mark in the text's", () => {
  render([merged]);
  expect(document.body.textContent).toContain("Monitoring pull request#934");
  const link = chip(934)!;
  expect(link.getAttribute("href")).toBe(merged);
  expect(link.querySelector("span span span")?.className).toContain("text-project-violet");
  expect(link.querySelector("svg")?.getAttribute("class")).toContain("text-foreground");
  // The state's color is the number's text, over the same neutral fill as a thread's chip.
  expect(link.querySelector('[class*="bg-foreground/"]')).not.toBeNull();
  expect(link.innerHTML).not.toContain("bg-project-violet");
});

test("one not read yet shows neutral, and each has its own chip", () => {
  render([merged, unread]);
  expect(document.body.textContent).toContain("Monitoring 2 pull requests");
  expect(chip(934)!.innerHTML).toContain("text-project-violet");
  expect(chip(935)!.innerHTML).toContain("text-muted-foreground");
});

test("those past the line's room count as +N, leave the tab order, and are all in the details", () => {
  // Everything after #934 wraps to a second line.
  const top = vi.spyOn(HTMLElement.prototype, "offsetTop", "get").mockImplementation(function (
    this: HTMLElement,
  ) {
    return this.textContent === "#934" ? 0 : 24;
  });
  vi.stubGlobal(
    "ResizeObserver",
    class {
      observe() {}
      disconnect() {}
    },
  );
  try {
    render([merged, unread, "https://github.com/o/r/pull/936"]);
    const more = document.querySelector<HTMLButtonElement>(
      'button[aria-label$="more pull requests"]',
    )!;
    expect(more.textContent).toBe("+2");
    expect(more.getAttribute("popovertarget")).toBe(document.querySelector("[popover]")!.id);
    const row = (n: number) =>
      [...document.querySelectorAll("a")].filter((a) => a.textContent === `#${n}`);
    expect(row(934)[0]!.parentElement!.className).not.toContain("invisible");
    expect(row(935)[0]!.parentElement!.className).toContain("invisible");
    // The details' copy of each stays visible.
    expect(row(936)).toHaveLength(2);
    expect(row(936)[1]!.closest("[popover]")).not.toBeNull();
  } finally {
    top.mockRestore();
    vi.unstubAllGlobals();
  }
});
