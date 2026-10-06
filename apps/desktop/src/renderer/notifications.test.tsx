// @vitest-environment happy-dom
import { act, type ReactNode } from "react";
import { createRoot } from "react-dom/client";
import { afterEach, expect, test, vi } from "vite-plus/test";

import type { ConnectionState, ParallaxBridge } from "../preload/bridge";
import type { AgentRun, Thread } from "../protocol/generated/protocol";
import { threadNotice, useConnectionAlarms, useThreadAlarms, type ThreadMark } from "./alarms";
import { NOTICE_MS, Notifications, notify } from "./notifications";
import type { HostThreads } from "./Sidebar";
import { emptyThreads, idleThreads, type ThreadsState } from "./threads";

Object.assign(globalThis, { IS_REACT_ACT_ENVIRONMENT: true });
// happy-dom has no popovers.
HTMLElement.prototype.showPopover = () => {};

let unmount = () => {};
afterEach(() => {
  // Notifications outlive a render, so close this test's.
  for (const close of document.querySelectorAll<HTMLButtonElement>('button[aria-label="Close"]'))
    act(() => close.click());
  act(() => unmount());
  vi.useRealTimers();
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
});

function render(node: ReactNode) {
  const root = createRoot(document.body.appendChild(document.createElement("div")));
  act(() => root.render(node));
  unmount = () => root.unmount();
  return (next: ReactNode) => act(() => root.render(next));
}

/** Each shown notification's title, newest first. */
const titles = () =>
  [...document.querySelectorAll('[aria-label="Notifications"] > div')].map(
    (n) => n.querySelector("span")!.textContent,
  );

test("a notice with a key replaces its last, news closes by itself, and what asks something stays", () => {
  vi.useFakeTimers();
  render(<Notifications />);
  expect(document.querySelector('[aria-label="Notifications"]')).toBeNull();
  act(() => notify({ key: "host", tone: "error", title: "Lost connection to dev" }));
  act(() => notify({ tone: "success", title: "Pushed" }));
  expect(titles()).toEqual(["Pushed", "Lost connection to dev"]);
  act(() => notify({ key: "host", tone: "success", title: "Reconnected to dev" }));
  expect(titles()).toEqual(["Reconnected to dev", "Pushed"]);

  act(() => notify({ tone: "attention", title: "Thread needs your input" }));
  act(() => void vi.advanceTimersByTime(NOTICE_MS));
  expect(titles()).toEqual(["Thread needs your input"]);

  // An action runs and closes its notice.
  const run = vi.fn();
  act(() => notify({ tone: "info", title: "Back", action: { label: "Open thread", run } }));
  const open = [...document.querySelectorAll("button")].find(
    (b) => b.textContent === "Open thread",
  );
  act(() => open!.click());
  expect(run).toHaveBeenCalledOnce();
  expect(titles()).toEqual(["Thread needs your input"]);
});

test("a system notice also goes to the OS only while the window is in the background", () => {
  const shown: string[] = [];
  vi.stubGlobal(
    "Notification",
    class {
      constructor(title: string) {
        shown.push(title);
      }
    },
  );
  render(<Notifications />);
  act(() => notify({ tone: "success", title: "Thread finished", system: true }));
  vi.spyOn(document, "hasFocus").mockReturnValue(false);
  act(() => notify({ tone: "success", title: "Another finished", system: true }));
  act(() => notify({ tone: "success", title: "Pushed" }));
  expect(shown).toEqual(["Another finished"]);
  expect(titles()).toEqual(["Pushed", "Another finished", "Thread finished"]);
});

test("only a finished or failed turn, needing the user, or a usage limit is news", () => {
  const notice = (before: ThreadMark, now: ThreadMark, run?: Partial<AgentRun>) =>
    threadNotice(before, now, "Fix the login bug", run as AgentRun | undefined);
  expect(notice("working", "done")).toEqual({
    tone: "success",
    title: "Thread finished",
    body: "Fix the login bug",
  });
  expect(notice("needsYou", "failed", { error: "exited with 1" })).toEqual({
    tone: "error",
    title: "Thread failed",
    body: "Fix the login bug: exited with 1",
  });
  expect(notice("working", "needsYou")!.title).toBe("Thread needs your input");
  expect(notice("working", "waiting", { resumeAt: "2026-10-04T15:05:00Z" })!.body).toMatch(
    /^Fix the login bug\. Resumes at .+\.$/,
  );
  // A finished run that changes again, as when a pull request is linked, is old news.
  expect(notice("settled", "done")).toBeUndefined();
  expect(notice("settled", "failed")).toBeUndefined();
  expect(notice("done", "settled")).toBeUndefined();
  expect(notice("settled", "working")).toBeUndefined();
});

test("any host's thread notifies with Open thread, except the one open in the focused window", () => {
  const thread = { id: "t-1", createdAt: "2026-10-04T12:00:00Z" } as Thread;
  const run = (status: AgentRun["status"]) =>
    ({ id: "t-1", status, updatedAt: "2026-10-04T12:05:00Z" }) as AgentRun;
  const hosts = (status: AgentRun["status"], id = "t-1"): HostThreads[] => [
    {
      host: { id: "dev", name: "dev box" },
      view: {
        ...idleThreads,
        state: {
          ...emptyThreads,
          threads: [{ ...thread, id }],
          titles: { [id]: "Fix the login bug" },
          runs: { [id]: { ...run(status), id } },
        },
      },
    },
  ];
  const onOpen = vi.fn();
  function Alarms({ list, openKey }: { list: HostThreads[]; openKey?: string }) {
    useThreadAlarms(list, onOpen, openKey ? [openKey] : []);
    return <Notifications />;
  }
  // Already finished when first listed: not news.
  const rerender = render(<Alarms list={hosts("completed")} />);
  expect(titles()).toEqual([]);
  rerender(<Alarms list={hosts("running")} />);
  rerender(<Alarms list={hosts("completed")} />);
  expect(titles()).toEqual(["Thread finished"]);
  const open = [...document.querySelectorAll("button")].find(
    (b) => b.textContent === "Open thread",
  );
  act(() => open!.click());
  expect(onOpen).toHaveBeenCalledWith("dev", "t-1");

  // The open thread in the focused window says nothing; in the background it does.
  rerender(<Alarms list={hosts("running")} openKey="dev/t-1" />);
  rerender(<Alarms list={hosts("failed")} openKey="dev/t-1" />);
  expect(titles()).toEqual([]);
  vi.spyOn(document, "hasFocus").mockReturnValue(false);
  vi.stubGlobal("Notification", class {});
  rerender(<Alarms list={hosts("running")} openKey="dev/t-1" />);
  rerender(<Alarms list={hosts("failed")} openKey="dev/t-1" />);
  expect(titles()).toEqual(["Thread failed"]);
});

test("a notice stays while the pointer is on it, and closes once it leaves", () => {
  vi.useFakeTimers();
  render(<Notifications />);
  act(() => notify({ tone: "success", title: "Pushed" }));
  const toast = document.querySelector('[aria-label="Notifications"] > div')!;
  act(() => void toast.dispatchEvent(new PointerEvent("pointerover", { bubbles: true })));
  act(() => void vi.advanceTimersByTime(NOTICE_MS * 2));
  expect(titles()).toEqual(["Pushed"]);
  act(() => void toast.dispatchEvent(new PointerEvent("pointerout", { bubbles: true })));
  act(() => void vi.advanceTimersByTime(NOTICE_MS));
  expect(titles()).toEqual([]);
});

test("a thread waiting on the user as its host's list loads, or reloads, is not news", () => {
  const thread = { id: "t-1", createdAt: "2026-10-04T12:00:00Z" } as Thread;
  const run = { id: "t-1", status: "running", updatedAt: "2026-10-04T12:05:00Z" } as AgentRun;
  // The list comes in before its permission requests.
  const hosts = (asks: number, loading: boolean): HostThreads[] => [
    {
      host: { id: "dev", name: "dev box" },
      view: {
        ...idleThreads,
        loading,
        state: {
          ...emptyThreads,
          threads: [thread],
          runs: { "t-1": run },
          approvals: asks ? { "t-1": { seq: 1, items: [{}] } } : {},
        } as unknown as ThreadsState,
      },
    },
  ];
  function Alarms({ list }: { list: HostThreads[] }) {
    useThreadAlarms(list, () => {}, []);
    return <Notifications />;
  }
  const rerender = render(<Alarms list={hosts(0, true)} />);
  rerender(<Alarms list={hosts(1, false)} />);
  // A resync: the list again, then its requests.
  rerender(<Alarms list={hosts(0, true)} />);
  rerender(<Alarms list={hosts(1, false)} />);
  expect(titles()).toEqual([]);
  // A request that comes after is.
  rerender(<Alarms list={hosts(0, false)} />);
  rerender(<Alarms list={hosts(1, false)} />);
  expect(titles()).toEqual(["Thread needs your input"]);
});

test("a host connected before the window listened says so when it drops and comes back", async () => {
  let change: (hostId: string, state: ConnectionState) => void = () => {};
  const connected = { status: "connected", plxd: "0.1.0", protocol: 1, capabilities: {} } as const;
  window.parallax = {
    connectionState: async () => connected,
    onConnectionState: (listener: typeof change) => {
      change = listener;
      return () => {};
    },
  } as Partial<ParallaxBridge> as ParallaxBridge;
  function Alarms() {
    useConnectionAlarms([{ id: "dev", name: "dev box" }]);
    return <Notifications />;
  }
  render(<Alarms />);
  await act(async () => {});
  act(() => change("dev", { status: "connecting" }));
  expect(titles()).toEqual(["Lost connection to dev box"]);
  act(() => change("dev", connected));
  expect(titles()).toEqual(["Reconnected to dev box"]);
});
