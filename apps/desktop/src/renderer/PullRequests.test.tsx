// @vitest-environment happy-dom
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, expect, test, vi } from "vite-plus/test";

import samples from "../../../../crates/parallax-protocol/samples/v1/pull-requests.json";
import type { ParallaxBridge } from "../preload/bridge";
import type { PullRequest } from "../protocol/generated/protocol";
import { PullRequestChip, PullRequestList, PullRequestView, usePullRequests } from "./PullRequests";
import { SidePanel } from "./SidePanel";

Object.assign(globalThis, { IS_REACT_ACT_ENVIRONMENT: true });
// happy-dom has no popovers. The menus are in the DOM either way.
HTMLElement.prototype.hidePopover = () => {};

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
  window.parallax = { platform: "darwin", request } as Partial<ParallaxBridge> as ParallaxBridge;
});

let root: Root | undefined;
afterEach(() => {
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
    return <>{view(usePullRequests("local", "run-1", urls))}</>;
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

test("the view shows the header, the checks' state, reviewers, labels, description, checks, and comments newest first", async () => {
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
  expect(header).toContain("me · updated 1h ago");
  expect(header).toContain("main ← parallax/add-readme");
  expect(header).toContain("1 file+12−0");
  expect(document.body.textContent).toContain("1 of 2 running");
  expect(document.querySelector("dl")!.textContent).toBe("Reviewersreviewer, docs-teamLabelsdocs");
  expect(document.body.textContent).toContain("Explains how to build the app.");

  // Checks start folded.
  expect(document.body.textContent).not.toContain("buildsuccess");
  await click(button("Checks (2)"));
  expect(document.body.textContent).toContain("buildsuccessDetails");

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
  expect(document.querySelector('[role="alert"]')!.textContent).toBe("not mergeable");

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

test("a pull request that can't be read says why", async () => {
  request.mockImplementationOnce(async () => ({
    logId: "l",
    error: { code: -32000, message: "gh isn't signed in", data: { kind: "ghUnavailable" } },
  }));
  await render([url(42)], (prs) => <PullRequestView url={url(42)} prs={prs} onCompose={vi.fn()} />);
  expect(document.querySelector('[role="alert"]')!.textContent).toBe("gh isn't signed in");
});

test("the side panel opens a pull request's tab, or the list, and hides tabs the thread doesn't link", async () => {
  root = createRoot(document.body.appendChild(document.createElement("div")));
  const panel = (urls: string[], pullRequest?: { url?: string }) =>
    act(() =>
      root!.render(
        <SidePanel
          open
          onClose={() => {}}
          expanded={false}
          onExpandedChange={() => {}}
          pullRequest={pullRequest}
          pullRequests={{
            urls,
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
