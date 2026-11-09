// @vitest-environment happy-dom
import { act } from "react";
import { createRoot } from "react-dom/client";
import { afterEach, expect, test, vi } from "vite-plus/test";

import { emptyThreads, type ThreadsState } from "./threads";
import { SentText, ThreadLinksContext, type OtherComputer } from "./threadContext";

Object.assign(globalThis, { IS_REACT_ACT_ENVIRONMENT: true });

const stateWith = (...threads: { id: string; title: string }[]): ThreadsState =>
  ({
    ...emptyThreads,
    threads: threads.map((t) => ({ ...t, repo: "r", createdAt: "2026-09-26T12:00:00Z" })),
  }) as ThreadsState;

const open = vi.fn();
const openOther = vi.fn();
const box: OtherComputer = {
  host: { id: "account:box", name: "build-box" },
  relayId: "box",
  connected: true,
  capable: true,
  state: stateWith(
    { id: "far", title: "Upload test" },
    { id: "far2", title: "Upload test" },
    { id: "login", title: "Fix /login page" },
    { id: "quoted", title: 'The "big" one' },
  ),
};

let unmount = () => {};
afterEach(() => {
  act(() => unmount());
  open.mockClear();
  openOther.mockClear();
});

function render(text: string, props: Omit<Parameters<typeof SentText>[0], "text" | "known">) {
  const div = document.createElement("div");
  const root = createRoot(div);
  unmount = () => root.unmount();
  act(() =>
    root.render(
      <ThreadLinksContext
        value={{
          hostId: "local",
          state: stateWith(
            { id: "here", title: "New title" },
            { id: "twin1", title: "Same task" },
            { id: "twin2", title: "Same task" },
          ),
          open,
          others: [box],
          openOther,
        }}
      >
        <SentText text={text} known={() => false} {...props} />
      </ThreadLinksContext>,
    ),
  );
  return div;
}

test("attached threads and computers stay where they were typed, as chips", () => {
  const div = render('@"build-box" and @"Upload test" then @"New title" ok', {
    threads: ["here"],
    computers: ["box"],
    remoteThreads: [{ computer: "box", runId: "far", title: "Upload test" }],
  });
  expect(div.textContent).toBe("build-box and Upload teston build-box then New title ok");
  act(() => div.querySelector<HTMLButtonElement>('[title="Open New title"]')!.click());
  expect(open).toHaveBeenCalledWith("here");
  act(() =>
    div.querySelector<HTMLButtonElement>('[title="Open Upload test on build-box"]')!.click(),
  );
  expect(openOther).toHaveBeenCalledWith("account:box", "far");
});

test("a renamed thread shows its title now, and a deleted one its saved title, unopenable", () => {
  expect(render('@"Old title" go', { threads: ["here"] }).textContent).toBe("New title go");
  const div = render('@"Gone thread" go', { threads: ["deleted"] });
  expect(div.textContent).toBe("Gone thread go");
  expect(div.querySelector("button")).toBeNull();
});

test("a quoted name nothing attached stays text", () => {
  expect(render('say @"hello" there', {}).textContent).toBe('say @"hello" there');
});

test("attachments sharing a title each get their own chip, opening their own thread", () => {
  const div = render('@"Same task" @"Same task" @"Upload test" @"Upload test"', {
    threads: ["twin1", "twin2"],
    remoteThreads: [
      { computer: "box", runId: "far", title: "Upload test" },
      { computer: "box", runId: "far2", title: "Upload test" },
    ],
  });
  for (const chip of div.querySelectorAll("button")) act(() => chip.click());
  expect(open.mock.calls).toEqual([["twin1"], ["twin2"]]);
  expect(openOther.mock.calls).toEqual([
    ["account:box", "far"],
    ["account:box", "far2"],
  ]);
});

test("a title with a quote or a skill-like word is a chip, and one the text never names leads", () => {
  const login = { computer: "box", runId: "login", title: "Fix /login page" };
  const quoted = { computer: "box", runId: "quoted", title: 'The "big" one' };
  const div = render('see @"Fix /login page" and @"The "big" one" now', {
    remoteThreads: [login, quoted],
  });
  expect(div.textContent).toBe('see Fix /login pageon build-box and The "big" oneon build-box now');
  expect(div.querySelectorAll("button")).toHaveLength(2);

  const lead = render("hello", {
    remoteThreads: [{ computer: "box", runId: "far", title: "Upload test" }],
  });
  expect(lead.textContent).toBe("Upload teston build-boxhello");
  act(() => lead.querySelector("button")!.click());
  expect(openOther).toHaveBeenCalledWith("account:box", "far");
});
