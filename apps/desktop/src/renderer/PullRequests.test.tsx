// @vitest-environment happy-dom
import { act, useState } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, expect, test, vi } from "vite-plus/test";

import diffSamples from "../../../../crates/parallax-protocol/samples/v1/pr-diff.json";
import samples from "../../../../crates/parallax-protocol/samples/v1/pull-requests.json";
import type { ParallaxBridge } from "../preload/bridge";
import type { PrDiffResult, PullRequest } from "../protocol/generated/protocol";
import {
  fileKind,
  githubText,
  LinkedPullRequests,
  lineBreakdown,
  linkedPr,
  parseDiff,
  PullRequestChip,
  PullRequestList,
  POLL_MS,
  PullRequestView,
  RUNNING_POLL_MS,
  usePullRequests,
} from "./PullRequests";
import { Notifications } from "./notifications";
import { setBehaviorPrefs } from "./prefs";
import { SidePanel } from "./SidePanel";

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
// The merged one with a commit and every kind of review, and its diff.
const merged = (diffSamples as { id?: number; result?: PullRequest }[]).find(
  (m) => m.id === 1 && m.result,
)!.result!;
const sampleDiff = (diffSamples as { id?: number; result?: PrDiffResult }[]).find(
  (m) => m.id === 2 && m.result,
)!.result!;
const now = Date.parse("2026-10-02T13:10:00Z");

let read: Record<string, PullRequest>;
let actions: Record<string, () => object>;
let diffs: Record<string, PrDiffResult>;
const request = vi.fn(async (_host: string, method: string, params: Record<string, unknown>) => {
  if (method === "pr/view") return { logId: "l", result: read[params["url"] as string] };
  if (method === "pr/act") return { logId: "l", ...actions[params["action"] as string]!() };
  if (method === "pr/diff") return { logId: "l", result: diffs[params["url"] as string] };
  return { logId: "l", result: {} };
});

beforeEach(() => {
  vi.useFakeTimers({ now, toFake: ["Date"] });
  request.mockClear();
  read = {};
  actions = {};
  diffs = {};
  window.parallax = { platform: "darwin", request } as Partial<ParallaxBridge> as ParallaxBridge;
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
const click = async (element: Element | null | undefined) => {
  await act(async () => (element as HTMLElement).click());
  await settle();
};
const button = (name: string) =>
  [...document.querySelectorAll<HTMLButtonElement>("button")].find((b) =>
    b.textContent?.startsWith(name),
  );
const item = (name: string) =>
  [...document.querySelectorAll<HTMLButtonElement>('[aria-label="Pull request"] button')].find(
    (b) => b.textContent?.startsWith(name),
  )!;

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

test("the chip shows the latest linked pull request in its state's color, and +k for the rest", async () => {
  read = { [url(41)]: prOf(41), [url(42)]: prOf(42, { state: "merged" }) };
  const onOpen = vi.fn();
  await render([url(42)], (prs) => <PullRequestChip prs={prs} onOpen={onOpen} />);
  expect(request).toHaveBeenCalledWith("local", "pr/view", { runId: "run-1", url: url(42) });
  let chip = document.querySelector("button")!;
  expect(chip.textContent).toBe("#42");
  expect(chip.querySelector("span")!.className).toContain("text-project-violet");
  // One pull request opens its view.
  await click(chip);
  expect(onOpen).toHaveBeenLastCalledWith(url(42));

  // Several open the list; the latest leads, and a draft is gray.
  read[url(43)] = prOf(43, { draft: true });
  await render([url(41), url(42), url(43)], (prs) => <PullRequestChip prs={prs} onOpen={onOpen} />);
  chip = document.querySelector("button")!;
  expect(chip.textContent).toBe("#43+2");
  expect(chip.querySelector("span")!.className).toContain("text-faint-foreground");
  await click(chip);
  expect(onOpen).toHaveBeenLastCalledWith(undefined);
});

test("the list shows each pull request newest first, with the open and linked counts", async () => {
  read = {
    [url(40)]: prOf(40, { state: "closed" }),
    [url(41)]: prOf(41, { additions: 1234, deletions: 5, updatedAt: "2026-10-02T08:10:00Z" }),
  };
  const onOpen = vi.fn();
  await render([url(40), url(41)], (prs) => <PullRequestList prs={prs} onOpen={onOpen} />);
  const rows = [...document.querySelectorAll("li")].map((li) => li.textContent);
  expect(rows).toEqual([
    "#41Change 41+1,234 −5meme/appparallax/add-readme → main5h ago",
    "#40Change 40+12 −0meme/appparallax/add-readme → main1h ago",
  ]);
  expect(document.querySelector("p")!.textContent).toBe("1 open · 2 linked · synced just now");
  await click(document.querySelectorAll("li button")[1]);
  expect(onOpen).toHaveBeenCalledWith(url(40));
});

test("Thread details lists the newest pull request with its checks, the rest behind Show more", async () => {
  read = {
    [url(40)]: prOf(40, { state: "merged" }),
    [url(41)]: prOf(41, { checksState: "failed" }),
  };
  const onOpen = vi.fn();
  await render([url(40), url(41)], (prs) => <LinkedPullRequests prs={prs} onOpen={onOpen} />);
  const rows = () => [...document.querySelectorAll("li")].map((li) => li.textContent);
  expect(rows()).toEqual(["Change 41#41"]);
  expect(document.querySelector('li [aria-label="Checks failed"]')).not.toBeNull();
  await click(button("Show 1 more"));
  expect(rows()).toEqual(["Change 41#41", "Change 40#40"]);
  await click(document.querySelectorAll("li button")[1]);
  expect(onOpen).toHaveBeenCalledWith(url(40));
  await click(button("Show less"));
  expect(rows()).toEqual(["Change 41#41"]);
});

test("the view shows the header, the checks' state, reviewers, labels, description, and comments newest first", async () => {
  read = {
    [url(42)]: prOf(42, {
      comments: [
        { author: "first", body: "Older.", createdAt: "2026-10-02T12:00:00Z" },
        { author: "second", body: "Line\n".repeat(20), createdAt: "2026-10-02T13:00:00Z" },
      ],
    }),
  };
  await render([url(42)], (prs) => <PullRequestView url={url(42)} prs={prs} onCompose={vi.fn()} />);
  const header = document.querySelector("header")!.textContent;
  expect(header).toContain("me/app#42");
  expect(header).toContain("Merge");
  expect(header).toContain("Change 42");
  expect(header).toContain("me· updated 1h ago");
  expect(header).toContain("synced just now");
  expect(header).toContain("main ← parallax/add-readme");
  expect(header).toContain("1 file+12−0");
  expect(document.body.textContent).toContain("1 of 2 running");
  expect(document.querySelector("dl")!.textContent).toBe("Reviewersreviewer, docs-teamLabelsdocs");
  expect(document.body.textContent).toContain("Explains how to build the app.");

  const comments = [...document.querySelectorAll("section:last-of-type li")];
  expect(comments.map((c) => c.querySelector("p")!.textContent)).toEqual([
    "second 10m ago",
    "first 1h ago",
  ]);
  // The long one is folded until asked.
  expect(comments[0]!.querySelector(".max-h-48")).not.toBeNull();
  expect(comments[1]!.textContent).not.toContain("Show full comment");
  await click(button("Show full comment"));
  expect(comments[0]!.querySelector(".max-h-48")).toBeNull();
});

test("an open pull request is read again every POLL_MS, and a merged one isn't", async () => {
  vi.useFakeTimers({ now, toFake: ["Date", "setInterval", "clearInterval"] });
  read = {
    [url(41)]: prOf(41, { state: "merged" }),
    [url(42)]: prOf(42, { checks: [], checksState: undefined }),
  };
  await render([url(41), url(42)], (prs) => (
    <PullRequestView url={url(42)} prs={prs} onCompose={vi.fn()} />
  ));
  expect(document.body.textContent).toContain("No checks");
  request.mockClear();

  // CI starts after the first read.
  read[url(42)] = prOf(42);
  await act(async () => void vi.advanceTimersByTime(POLL_MS));
  await settle();
  expect(request.mock.calls.map(([, , params]) => params["url"])).toEqual([url(42)]);
  expect(document.body.textContent).toContain("1 of 2 running");
});

test("one whose checks run is read again every RUNNING_POLL_MS, until they end", async () => {
  vi.useFakeTimers({ now, toFake: ["Date", "setInterval", "clearInterval"] });
  // One failed check rolls the state up to failed while the other still runs.
  read = { [url(42)]: prOf(42, { checksState: "failed" }) };
  await render([url(42)], () => null);
  request.mockClear();
  read[url(42)] = prOf(42, { checks: [sample.checks[0]!], checksState: "passed" });
  await act(async () => void vi.advanceTimersByTime(RUNNING_POLL_MS));
  await settle();
  expect(request).toHaveBeenCalledOnce();
  // Passed, it waits for POLL_MS again.
  await act(async () => void vi.advanceTimersByTime(RUNNING_POLL_MS));
  await settle();
  expect(request).toHaveBeenCalledOnce();
});

test("focus reads again a pull request not read within RUNNING_POLL_MS", async () => {
  vi.useFakeTimers({ now, toFake: ["Date", "setInterval", "clearInterval"] });
  read = { [url(42)]: prOf(42, { checks: [], checksState: undefined }) };
  await render([url(42)], () => null);
  request.mockClear();
  await act(async () => void window.dispatchEvent(new Event("focus")));
  expect(request).not.toHaveBeenCalled();
  vi.setSystemTime(now + RUNNING_POLL_MS);
  await act(async () => void window.dispatchEvent(new Event("focus")));
  await settle();
  expect(request).toHaveBeenCalledOnce();
});

test("a check running longer than STUCK_MS waits for POLL_MS", async () => {
  vi.useFakeTimers({ now, toFake: ["Date", "setInterval", "clearInterval"] });
  const stuck = { name: "deploy", state: "pending" as const, startedAt: "2026-10-02T11:00:00Z" };
  read = { [url(42)]: prOf(42, { checks: [stuck] }) };
  await render([url(42)], () => null);
  request.mockClear();
  await act(async () => void vi.advanceTimersByTime(RUNNING_POLL_MS));
  await settle();
  expect(request).not.toHaveBeenCalled();
  await act(async () => void vi.advanceTimersByTime(POLL_MS));
  await settle();
  expect(request).toHaveBeenCalledOnce();
});

test("the checks' state opens every check, failed first, spinning a running one, with its details and page", async () => {
  const failed = {
    name: "lint",
    state: "failed" as const,
    conclusion: "timed_out",
    url: "https://github.com/me/app/runs/9",
  };
  read = { [url(42)]: prOf(42, { checks: [...sample.checks, failed] }) };
  const onCompose = vi.fn();
  const open = vi.fn();
  vi.stubGlobal("open", open);
  await render([url(42)], (prs) => (
    <PullRequestView url={url(42)} prs={prs} onCompose={onCompose} />
  ));
  const checks = document.querySelector('[aria-label="Checks"]')!;
  expect(button("1 of 3 running")!.getAttribute("popovertarget")).toBe(checks.id);
  expect(checks.querySelector("p")!.textContent).toBe("1 failed · 1 running · 1 passed");
  const rows = [...checks.querySelectorAll("li")];
  expect(rows.map((li) => li.textContent)).toEqual([
    "lintTimed outDetails",
    "CI / testRunning for 3m 0sDetails",
    "CI / buildSuccess in 3m 30sDetails",
  ]);
  expect(rows[1]!.querySelector("svg")!.getAttribute("class")).toContain("animate-spin");
  expect(rows[2]!.querySelector("svg")!.getAttribute("class")).not.toContain("animate-spin");

  await click(rows[2]!.querySelector('[aria-label="Open build on GitHub"]'));
  expect(open).toHaveBeenCalledWith("https://github.com/me/app/actions/runs/1/job/2", "_blank");
  await click(rows[0]!.querySelector("button"));
  expect(rows[0]!.textContent).toContain("StatusTimed out");
  await click(button("Fix in this thread"));
  expect(onCompose.mock.calls[0]![0]).toContain('The "lint" check failed');
});

test("a screenshot opens large, with its name and place, and arrows to the others", async () => {
  read = {
    [url(42)]: prOf(42, {
      body: '<img width="300" alt="Before" src="https://github.com/user-attachments/assets/a1"> ![image](https://raw.githubusercontent.com/me/app/1/after.png)',
    }),
  };
  HTMLDialogElement.prototype.showModal = vi.fn();
  HTMLDialogElement.prototype.close = function () {
    this.dispatchEvent(new Event("close"));
  };
  await render([url(42)], (prs) => <PullRequestView url={url(42)} prs={prs} onCompose={vi.fn()} />);
  await click(document.querySelector("img[data-shot]"));
  const box = () => document.querySelector("dialog[aria-label]");
  expect(box()!.textContent).toBe("Before1 / 2");
  await act(async () =>
    box()!.dispatchEvent(new KeyboardEvent("keydown", { key: "ArrowRight", bubbles: true })),
  );
  // Without useful alt text, the file's name.
  expect(box()!.textContent).toBe("after.png2 / 2");
  const zoom = box()!.querySelector(".cursor-zoom-in")!;
  await click(zoom);
  expect(zoom.className).toContain("cursor-zoom-out");
  await click(box()!.querySelector('[aria-label="Close"]'));
  expect(box()).toBeNull();
});

test("githubText makes HTML images Markdown, and linkedPr finds a linked one from any of its tabs", () => {
  expect(githubText('<img alt="A [b]" src="https://x/y.png" />')).toBe("![A b](https://x/y.png)");
  // Code shows the tag as written.
  const code = '`<img src="a.png">` and\n```html\n<img src="b.png">\n```\n';
  expect(githubText(code)).toBe(code);
  expect(linkedPr(`${url(42)}/files#diff`, [url(4), url(42)])).toBe(url(42));
  expect(linkedPr(url(7), [url(42)])).toBeUndefined();
});

test("a poll skips a pull request whose last read hasn't answered", async () => {
  vi.useFakeTimers({ now, toFake: ["Date", "setInterval", "clearInterval"] });
  read = { [url(42)]: prOf(42) };
  await render([url(42)], () => null);
  let answer!: () => void;
  request.mockImplementationOnce(
    () => new Promise((resolve) => (answer = () => resolve({ logId: "l", result: prOf(42) }))),
  );
  request.mockClear();
  await act(async () => void vi.advanceTimersByTime(POLL_MS * 2));
  expect(request).toHaveBeenCalledTimes(1);
  await act(async () => answer());
  await settle();
  await act(async () => void vi.advanceTimersByTime(POLL_MS));
  expect(request).toHaveBeenCalledTimes(2);
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

test("GitHub's images in the description and comments load, and others stay links", async () => {
  read = {
    [url(42)]: prOf(42, {
      body: "![The toast](https://raw.githubusercontent.com/me/app/1/toast.gif) ![Badge](https://example.com/a.png)",
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
    ["Shot", "https://github.com/user-attachments/assets/1"],
  ]);
  const badge = [...document.querySelectorAll(".markdown a")].find(
    (a) => a.textContent === "Badge",
  );
  expect(badge?.getAttribute("href")).toBe("https://example.com/a.png");
});

test("auto-merge on shows in the Merge button, which turns it off", async () => {
  read = { [url(42)]: prOf(42, { autoMerge: "merge" }) };
  actions = { disableAutoMerge: () => ({ result: prOf(42) }) };
  await render([url(42)], (prs) => <PullRequestView url={url(42)} prs={prs} onCompose={vi.fn()} />);
  await click(button("Auto-merge (merge)"));
  expect(request).toHaveBeenCalledWith("local", "pr/act", {
    runId: "run-1",
    url: url(42),
    action: "disableAutoMerge",
  });
  expect(button("Merge")).toBeDefined();
});

test("the menu acts on the pull request, shows what GitHub has after, and says why one failed", async () => {
  read = { [url(42)]: prOf(42) };
  actions = {
    draft: () => ({ result: prOf(42, { draft: true }) }),
    autoMerge: () => ({ result: prOf(42, { autoMerge: "merge" }) }),
    squash: () => ({
      error: { code: -32000, message: "not mergeable", data: { kind: "prFailed" } },
    }),
  };
  const onCompose = vi.fn();
  const writeText = vi.fn(async () => {});
  vi.stubGlobal("navigator", { clipboard: { writeText } });
  const open = vi.fn();
  vi.stubGlobal("open", open);
  await render([url(42)], (prs) => (
    <PullRequestView url={url(42)} prs={prs} onCompose={onCompose} />
  ));

  await click(item("Convert to draft"));
  expect(item("Ready for review")).toBeDefined();
  await click(item("Enable auto-merge"));
  expect(button("Auto-merge (merge)")).toBeDefined();
  await click(item("Squash and merge"));
  const notice = notices.querySelector('[aria-label="Notifications"] > div')!;
  expect(notice.querySelector("span")!.textContent).toBe("Couldn't update the pull request");
  expect(notice.querySelector("p")!.textContent).toBe("not mergeable");

  read[url(42)] = prOf(42, { title: "Renamed" });
  await click(item("Refresh"));
  expect(document.querySelector("h2")!.textContent).toBe("Renamed");
  expect(document.querySelector('[role="alert"]')).toBeNull();

  await click(item("Ask a question"));
  expect(onCompose).toHaveBeenLastCalledWith(`${url(42)} `, false);
  await click(item("Explain this PR"));
  expect(onCompose).toHaveBeenLastCalledWith(expect.stringContaining(url(42)), true);
  await click(item("Fix findings in this thread"));
  expect(onCompose).toHaveBeenLastCalledWith(expect.stringContaining(url(42)), true);

  await click(item("Copy link"));
  expect(writeText).toHaveBeenLastCalledWith(url(42));
  await click(item("Copy PR number"));
  expect(writeText).toHaveBeenLastCalledWith("42");
  await click(item("Open on GitHub"));
  expect(open).toHaveBeenCalledWith(url(42), "_blank");
});

test("Close asks first, then closes", async () => {
  read = { [url(42)]: prOf(42) };
  actions = { close: () => ({ result: prOf(42, { state: "closed" }) }) };
  const showModal = vi.fn();
  HTMLDialogElement.prototype.showModal = showModal;
  await render([url(42)], (prs) => <PullRequestView url={url(42)} prs={prs} onCompose={vi.fn()} />);
  await click(item("Close pull request"));
  expect(showModal).toHaveBeenCalled();
  expect(request.mock.calls.some(([, m]) => m === "pr/act")).toBe(false);
  const dialog = document.querySelector("dialog")!;
  await click(
    [...dialog.querySelectorAll("button")].find((b) => b.textContent === "Close pull request"),
  );
  expect(request).toHaveBeenCalledWith("local", "pr/act", {
    runId: "run-1",
    url: url(42),
    action: "close",
  });
  // Closed: no Merge, and its state in its place.
  expect(document.querySelector("header")!.textContent).toContain("Closed");
  expect(document.querySelector('[aria-label="Merge options"]')).toBeNull();
});

test("a pull request that can't be read for gh says so in one line by Set up GitHub", async () => {
  request.mockImplementationOnce(async () => ({
    logId: "l",
    error: {
      code: -32000,
      message: "GitHub CLI isn't signed in on the host; run `gh auth login` there: not logged in",
      data: { kind: "ghUnavailable" },
    },
  }));
  const onSetUpGithub = vi.fn();
  await render([url(42)], (prs) => (
    <PullRequestView url={url(42)} prs={prs} onCompose={vi.fn()} onSetUpGithub={onSetUpGithub} />
  ));
  expect(document.querySelector('[role="alert"]')!.textContent).toBe(
    "GitHub isn't signed in on this host.",
  );
  await click(button("Set up GitHub"));
  expect(onSetUpGithub).toHaveBeenCalledOnce();
});

test("the side panel opens a pull request's tab, or the list, and hides tabs the thread doesn't link", async () => {
  root = createRoot(document.body.appendChild(document.createElement("div")));
  const panel = (urls: string[], pullRequest?: { url?: string }) =>
    act(() =>
      root!.render(
        <SidePanel
          scope="t"
          open
          onClose={() => {}}
          expanded={false}
          onExpandedChange={() => {}}
          pullRequest={pullRequest}
          pullRequests={{
            urls,
            get: () => undefined,
            list: <p>the list</p>,
            view: (u) => <p>view of {u}</p>,
          }}
        />,
      ),
    );
  const tabs = () =>
    [...document.querySelectorAll('[aria-label="Open views"] button[id]')].map(
      (t) => `${t.textContent}${t.getAttribute("aria-current") === "true" ? "*" : ""}`,
    );
  const shown = () => document.querySelector("#side-panel > div:not(.titlebar):not([hidden])");

  panel([url(41), url(42)]);
  panel([url(41), url(42)], { url: url(42) });
  expect(tabs()).toEqual(["#42*"]);
  expect(shown()!.textContent).toBe(`view of ${url(42)}`);
  panel([url(41), url(42)], {});
  expect(tabs()).toEqual(["#42", "Pull requests*"]);
  expect(shown()!.textContent).toBe("the list");
  // Another thread: its own pull requests only.
  panel([url(7)], {});
  expect(tabs()).toEqual(["Pull requests*"]);
});

test("the timeline shows opening, commits, comments, reviews, and the merge, newest first or oldest", async () => {
  read = {
    [url(42)]: {
      ...merged,
      comments: [{ author: "reviewer", body: "Nice.", createdAt: "2026-10-02T12:14:00Z" }],
    },
  };
  await render([url(42)], (prs) => <PullRequestView url={url(42)} prs={prs} onCompose={vi.fn()} />);
  await click(document.querySelector('[role="tab"]:nth-child(2)'));
  const rows = () =>
    [...document.querySelectorAll('[aria-label="Timeline"] > li')].map(
      (li) => li.querySelector("p")!.textContent,
    );
  expect(rows()).toEqual([
    "reviewer merged parallax/add-readme into main",
    "bot had a review dismissed",
    "bot reviewed",
    "bot requested changes",
    "reviewer approved these changes",
    "reviewer commented",
    "me opened this pull request",
    "docs: add a README",
  ]);
  await click(button("Newest first"));
  expect(rows()[0]).toBe("docs: add a README");
});

test("the code tab reads the diff once and shows each file numbered, folding a viewed one", async () => {
  read = { [url(42)]: merged };
  diffs = { [url(42)]: sampleDiff };
  await render([url(42)], (prs) => <PullRequestView url={url(42)} prs={prs} onCompose={vi.fn()} />);
  expect(request.mock.calls.some(([, m]) => m === "pr/diff")).toBe(false);
  await click(document.querySelector('[role="tab"]:nth-child(3)'));
  expect(request).toHaveBeenCalledWith("local", "pr/diff", { runId: "run-1", url: url(42) });
  expect(document.body.textContent).toContain("1 file · 0 / 1 viewed");
  const file = document.querySelector('[aria-label="Changed files"] li')!;
  expect(file.textContent).toContain("README.md+2 −0");
  expect(file.textContent).toContain("1+Added: # App");
  await click(file.querySelector('input[type="checkbox"]'));
  expect(document.body.textContent).toContain("1 file · 1 / 1 viewed");
  expect(file.textContent).not.toContain("# App");

  // Back again: the same diff, not read again.
  await click(document.querySelector('[role="tab"]:nth-child(1)'));
  await click(document.querySelector('[role="tab"]:nth-child(3)'));
  expect(request.mock.calls.filter(([, m]) => m === "pr/diff")).toHaveLength(1);
});

test("a re-render while the diff is read doesn't read it again", async () => {
  read = { [url(42)]: merged };
  let answer!: (value: { logId: string; result: PrDiffResult }) => void;
  request.mockImplementation(async (_host, method, params) => {
    if (method === "pr/diff")
      return new Promise<{ logId: string; result: PrDiffResult }>((resolve) => (answer = resolve));
    return { logId: "l", result: read[params["url"] as string] };
  });
  let rerender!: () => void;
  function Harness() {
    const [, set] = useState(0);
    rerender = () => set((n) => n + 1);
    const prs = usePullRequests("local", "run-1", [url(42)], true);
    return <PullRequestView url={url(42)} prs={prs} onCompose={vi.fn()} />;
  }
  root = createRoot(document.body.appendChild(document.createElement("div")));
  act(() => root!.render(<Harness />));
  await settle();
  await click(document.querySelector('[role="tab"]:nth-child(3)'));
  act(() => rerender());
  await settle();
  await act(async () => answer({ logId: "l", result: sampleDiff }));
  await settle();
  expect(request.mock.calls.filter(([, m]) => m === "pr/diff")).toHaveLength(1);
  expect(document.body.textContent).toContain("1 file · 0 / 1 viewed");
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

test("fileKind sorts paths into code, tests, mocks, docs, and generated files", () => {
  const kinds = {
    "daemon/src/worktree/pull_request.rs": "Code",
    "apps/desktop/src/renderer/Latest.tsx": "Code",
    "daemon/tests/server/pull_requests.rs": "Tests",
    "apps/desktop/e2e/threads.spec.ts": "Tests",
    "apps/desktop/src/renderer/PullRequests.test.tsx": "Tests",
    "pkg/run_test.go": "Tests",
    "apps/desktop/preview/mockBridge.ts": "Mocks",
    "crates/parallax-protocol/samples/v1/pr-diff.json": "Mocks",
    "daemon/tests/fixtures/claude.jsonl": "Mocks",
    "docs/PLAN.md": "Docs",
    "README.md": "Docs",
    "docs/spec/api.md": "Docs",
    "requirements.txt": "Code",
    "Cargo.lock": "Generated",
    "apps/desktop/pnpm-lock.yaml": "Generated",
    "apps/desktop/src/protocol/generated/protocol.ts": "Generated",
  };
  expect(Object.fromEntries(Object.keys(kinds).map((p) => [p, fileKind(p)]))).toEqual(kinds);
});

test("lineBreakdown adds up each kind, and puts lines in unlisted files under Other", () => {
  const files = [
    { path: "src/a.ts", additions: 10, deletions: 2 },
    { path: "src/a.test.ts", additions: 5, deletions: 0 },
    { path: "src/b.ts", additions: 1, deletions: 1 },
  ];
  expect(lineBreakdown(prOf(1, { additions: 20, deletions: 3, files }))).toEqual([
    { kind: "Code", additions: 11, deletions: 3 },
    { kind: "Tests", additions: 5, deletions: 0 },
    { kind: "Other", additions: 4, deletions: 0 },
  ]);
});

test("Open on GitHub goes to the side panel's Browser when Settings says so", async () => {
  read = { [url(42)]: prOf(42) };
  const onBrowse = vi.fn();
  const open = vi.spyOn(window, "open").mockImplementation(() => null);
  const view = (prs: Parameters<typeof PullRequestView>[0]["prs"]) => (
    <PullRequestView url={url(42)} prs={prs} onCompose={vi.fn()} onBrowse={onBrowse} />
  );
  const link = () => document.querySelector<HTMLAnchorElement>('a[title="Open on GitHub"]')!;
  try {
    await render([url(42)], view);
    await click(link());
    expect(onBrowse).not.toHaveBeenCalled();

    await act(async () => setBehaviorPrefs({ openPrsIn: "browser" }));
    await click(link());
    await click(item("Open on GitHub"));
    expect(onBrowse.mock.calls).toEqual([[url(42)], [url(42)]]);
    expect(open).not.toHaveBeenCalled();
  } finally {
    setBehaviorPrefs({ openPrsIn: "external" });
    open.mockRestore();
  }
});
