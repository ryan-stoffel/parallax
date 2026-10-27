// @vitest-environment happy-dom
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, expect, test, vi } from "vite-plus/test";

import samples from "../../../../crates/parallax-protocol/samples/v1/pull-requests.json";
import type { ParallaxBridge } from "../preload/bridge";
import type { PullRequest } from "../protocol/generated/protocol";
import { githubText } from "./github";
import {
  LinkedPullRequests,
  linkedPr,
  parseDiff,
  PullRequestView,
  usePullRequests,
} from "./PullRequests";
import "./markdownTest";
import { Notifications } from "./notifications";

Object.assign(globalThis, { IS_REACT_ACT_ENVIRONMENT: true });
// happy-dom has no popovers. The menus are in the DOM either way.
HTMLElement.prototype.hidePopover = () => {};
HTMLElement.prototype.showPopover = () => {};
// The notifications, outside the body, which a test's cleanup clears.
const notices = document.documentElement.appendChild(document.createElement("div"));
createRoot(notices).render(<Notifications />);

// The sample's pull request: open, two checks with one pending, and one comment.
const sample = (samples as { id?: number; result?: PullRequest }[]).find(
  (m) => m.id === 2 && m.result,
)!.result!;
const url = (n: number) => `https://github.com/me/app/pull/${n}`;
const prOf = (n: number, more: Partial<PullRequest> = {}): PullRequest => ({
  ...sample,
  number: n,
  url: url(n),
  title: `Change ${n}`,
  ...more,
});
const now = Date.parse("2026-10-02T13:10:00Z");

let read: Record<string, PullRequest>;
let actions: Record<string, () => object>;
const request = vi.fn(async (_host: string, method: string, params: Record<string, unknown>) => {
  if (method === "pr/view") return { logId: "l", result: read[params["url"] as string] };
  if (method === "pr/act") return { logId: "l", ...actions[params["action"] as string]!() };
  return { logId: "l", result: {} };
});

beforeEach(() => {
  vi.useFakeTimers({ now, toFake: ["Date"] });
  request.mockClear();
  read = {};
  actions = {};
  window.parallax = {
    platform: "darwin",
    request,
    siteIcon: async () => undefined,
  } as Partial<ParallaxBridge> as ParallaxBridge;
});

let root: Root | undefined;
afterEach(() => {
  // Notifications outlive a render, so close this test's.
  for (const close of notices.querySelectorAll<HTMLButtonElement>('button[aria-label="Close"]'))
    act(() => close.click());
  act(() => root?.unmount());
  root = undefined;
  document.body.innerHTML = "";
  vi.useRealTimers();
  vi.unstubAllGlobals();
});

const settle = async () => {
  for (let i = 0; i < 10; i++) await act(async () => {});
};

/** Reads `urls` for run-1 and renders what `view` makes of them. */
async function render(
  urls: string[],
  view: (prs: ReturnType<typeof usePullRequests>) => React.ReactNode,
) {
  function Harness() {
    return <>{view(usePullRequests("local", "run-1", urls, true))}</>;
  }
  root ??= createRoot(document.body.appendChild(document.createElement("div")));
  act(() => root!.render(<Harness />));
  await settle();
}

test("Thread details counts a pull request's passed checks of those that count, spinning while one runs", async () => {
  read = {
    [url(1)]: prOf(1, {
      title: "A long title that wraps onto a second line in Thread details",
      checks: [...sample.checks, { name: "docs", state: "skipped" }],
    }),
  };
  await render([url(1)], (prs) => <LinkedPullRequests prs={prs} onOpen={() => {}} />);
  const checks = document.querySelector('[role="img"]')!;
  expect(checks.textContent).toBe("1/2");
  expect(checks.getAttribute("aria-label")).toBe("1 of 2 checks passed, 1 running");
  expect(checks.querySelector("svg")!.getAttribute("class")).toContain("animate-spin");
  expect(document.querySelector(".line-clamp-2")!.textContent).toBe(read[url(1)]!.title);
});

test("Thread details shows 3 linked pull requests, 10 after Show more, and past those View all", async () => {
  const urls = Array.from({ length: 12 }, (_, i) => url(i + 1));
  read = Object.fromEntries(urls.map((u, i) => [u, prOf(i + 1)]));
  const onOpen = vi.fn();
  await render(urls, (prs) => <LinkedPullRequests prs={prs} onOpen={onOpen} />);
  const titles = () => [...document.querySelectorAll(".line-clamp-2")].map((t) => t.textContent);
  const button = (name: string) =>
    [...document.querySelectorAll("button")].find((b) => b.textContent === name);
  expect(titles()).toEqual(["Change 12", "Change 11", "Change 10"]);
  expect(button("View all 12")).toBeUndefined();
  act(() => button("Show 7 more")!.click());
  expect(titles()).toHaveLength(10);
  act(() => button("View all 12")!.click());
  expect(onOpen).toHaveBeenCalledWith();
});

test("githubText makes HTML images Markdown, and linkedPr finds a linked one from any of its tabs", () => {
  expect(githubText('<img alt="A [b]" src="https://x/y.png" />')).toBe("![A b](https://x/y.png)");
  // Code shows the tag as written.
  const code = '`<img src="a.png">` and\n```html\n<img src="b.png">\n```\n';
  expect(githubText(code)).toBe(code);
  expect(linkedPr(`${url(42)}/files#diff`, [url(4), url(42)])).toBe(url(42));
  expect(linkedPr(url(7), [url(42)])).toBeUndefined();
});

test("a read sent before a merge doesn't overwrite the merge's answer", async () => {
  read = { [url(42)]: prOf(42) };
  actions = { merge: () => ({ result: prOf(42, { state: "merged" }) }) };
  let prs!: ReturnType<typeof usePullRequests>;
  await render([url(42)], (p) => {
    prs = p;
    return null;
  });
  let answer!: () => void;
  request.mockImplementationOnce(
    () => new Promise((resolve) => (answer = () => resolve({ logId: "l", result: prOf(42) }))),
  );
  const polled = prs.refresh(url(42));
  vi.setSystemTime(now + 1000);
  await act(() => prs.act(url(42), "merge"));
  vi.setSystemTime(now + 2000);
  await act(async () => {
    answer();
    await polled;
  });
  expect(prs.get(url(42))?.pr?.state).toBe("merged");
});

test("https images in the description and comments load wherever they're hosted, and others stay links", async () => {
  read = {
    [url(42)]: prOf(42, {
      body: "![The toast](https://raw.githubusercontent.com/me/app/1/toast.gif) ![Badge](https://files.example.com/a.png) ![Plain](http://example.com/b.png)",
      comments: [
        {
          author: "rev",
          body: "![Shot](https://github.com/user-attachments/assets/1)",
          createdAt: sample.updatedAt,
        },
      ],
    }),
  };
  await render([url(42)], (prs) => <PullRequestView url={url(42)} prs={prs} onCompose={vi.fn()} />);
  const images = [...document.querySelectorAll("img")].map((img) => [img.alt, img.src]);
  expect(images).toEqual([
    ["The toast", "https://raw.githubusercontent.com/me/app/1/toast.gif"],
    ["Badge", "https://files.example.com/a.png"],
    ["Shot", "https://github.com/user-attachments/assets/1"],
  ]);
  const plain = [...document.querySelectorAll(".enriched a")].find(
    (a) => a.textContent === "Plain",
  );
  expect(plain?.getAttribute("href")).toBe("http://example.com/b.png");
});

test("parseDiff numbers each side, and keeps renames and binary files", () => {
  const files = parseDiff(
    [
      "diff --git a/a.txt b/a.txt",
      "index 1..2 100644",
      "--- a/a.txt",
      "+++ b/a.txt",
      "@@ -10,3 +10,3 @@ fn main",
      " keep",
      "--- gone",
      "+++ here",
      "\\ No newline at end of file",
      "diff --git a/old.png b/new.png",
      "rename from old.png",
      "rename to new.png",
      "Binary files a/old.png and b/new.png differ",
      "",
    ].join("\n"),
  );
  expect(files).toEqual([
    {
      path: "a.txt",
      added: 1,
      removed: 1,
      binary: false,
      lines: [
        { op: "@", text: "@@ -10,3 +10,3 @@ fn main" },
        { op: " ", text: "keep", old: 10, new: 10 },
        { op: "-", text: "-- gone", old: 11 },
        { op: "+", text: "++ here", new: 11 },
      ],
    },
    { path: "new.png", oldPath: "old.png", added: 0, removed: 0, binary: true, lines: [] },
  ]);
  // A path with ` b/` in it, and one git quotes.
  expect(
    parseDiff(
      [
        "diff --git a/x b/y.bin b/x b/y.bin",
        "Binary files a/x b/y.bin and b/x b/y.bin differ",
        'diff --git "a/caf\\303\\251.md" "b/caf\\303\\251.md"',
        '--- "a/caf\\303\\251.md"',
        '+++ "b/caf\\303\\251.md"',
      ].join("\n"),
    ).map((f) => f.path),
  ).toEqual(["x b/y.bin", "caf\\303\\251.md"]);
});
