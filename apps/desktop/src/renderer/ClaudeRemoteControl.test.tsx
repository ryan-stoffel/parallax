// @vitest-environment happy-dom
import { act } from "react";
import { createRoot } from "react-dom/client";
import { afterEach, expect, test } from "vite-plus/test";

import type { RemoteControlSession } from "../protocol/generated/protocol";
import { RemoteControlSection, RemoteControlTab } from "./ClaudeRemoteControl";
import { ThreadDetails } from "./ThreadDetails";

Object.assign(globalThis, { IS_REACT_ACT_ENVIRONMENT: true });

let unmount = () => {};
afterEach(() => act(() => unmount()));

function show(node: React.ReactNode) {
  const root = createRoot(document.body.appendChild(document.createElement("div")));
  act(() => root.render(node));
  unmount = () => {
    root.unmount();
    document.body.innerHTML = "";
  };
  return document.body;
}

const session = (state: RemoteControlSession["state"]): RemoteControlSession => ({
  sessionId: "session_1",
  url: "https://claude.ai/code/session_1",
  repository: "ryan-stoffel/learn-rust",
  branch: "main",
  state,
});

test("the composer's tab says what the session's state means for a message", () => {
  const body = show(<RemoteControlTab session={session("offline")} />);
  expect(body.textContent).toBe(
    "Remote ControlOfflineYour message is queued until the computer is backOpen in Claude",
  );
  expect(body.querySelector("a")?.getAttribute("href")).toBe("https://claude.ai/code/session_1");
  act(() => unmount());
  expect(show(<RemoteControlTab session={session("waiting")} />).textContent).toContain(
    "Waiting for your answer in Claude",
  );
  act(() => unmount());
  // Before plxd has read it, it still says what the thread is.
  expect(show(<RemoteControlTab />).textContent).toBe("Remote Control");
  act(() => unmount());
  const compact = show(<RemoteControlTab session={session("running")} compact />);
  expect(compact.querySelector("[title]")?.getAttribute("title")).toBe(
    "Claude Remote Control: Working",
  );
});

test("Thread details names Claude Remote Control, its state, repository, and branch, not a device", () => {
  const body = show(<RemoteControlSection session={session("idle")} />);
  const section = body.querySelector('section[aria-label="Claude Remote Control"]')!;
  expect([...section.children].map((row) => row.textContent)).toEqual([
    "Claude Remote Control",
    "Idle",
    "ryan-stoffel/learn-rust",
    "main",
    "Open in Claude",
  ]);
});

test("Thread details leaves out this computer's folder, apps, actions, and Git for a Remote Control thread", () => {
  const body = show(
    <ThreadDetails
      mode="docked"
      host={{ id: "local", name: "macbook" }}
      folder="/Users/ryan/Developer/learn-rust"
      actions={{ hostId: "local", repoId: "r", canRun: true, onRun: () => {} }}
      git={{ hostId: "local" }}
      remoteControl={{ session: session("idle") }}
    />,
  );
  const sections = [...body.querySelectorAll("aside section")].map((s) =>
    s.getAttribute("aria-label"),
  );
  expect(sections).toEqual(["Claude Remote Control"]);
  expect(body.textContent).not.toContain("macbook");
});
