// @vitest-environment happy-dom
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, expect, test } from "vite-plus/test";

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

test("a watched pull request's number is a link in its state's color, with GitHub's mark", () => {
  render([merged]);
  expect(document.body.textContent).toContain("Monitoring pull request#934");
  const link = chip(934)!;
  expect(link.getAttribute("href")).toBe(merged);
  expect(link.className).toContain("text-project-violet");
  expect(link.querySelector("svg")).not.toBeNull();
});

test("one not read yet shows neutral, and each has its own chip", () => {
  render([merged, unread]);
  expect(document.body.textContent).toContain("Monitoring 2 pull requests");
  expect(chip(934)!.className).toContain("text-project-violet");
  expect(chip(935)!.className).toContain("text-muted-foreground");
});
