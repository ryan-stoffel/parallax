// @vitest-environment happy-dom
import { act, type ReactNode } from "react";
import { createRoot } from "react-dom/client";
import { afterEach, expect, test, vi } from "vite-plus/test";

import type { AgentRun, Thread } from "../protocol/generated/protocol";
import { useThreadAlarms } from "./alarms";
import { Notifications } from "./notifications";
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
