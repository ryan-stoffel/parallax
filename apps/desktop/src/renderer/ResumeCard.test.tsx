// @vitest-environment happy-dom
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, expect, test, vi } from "vite-plus/test";

import type { ParallaxBridge } from "../preload/bridge";
import type { AgentRun } from "../protocol/generated/protocol";
import { Notifications } from "./notifications";
import { ResumeCard, resumeTime } from "./ResumeCard";

Object.assign(globalThis, { IS_REACT_ACT_ENVIRONMENT: true });
// happy-dom has no popovers.
HTMLElement.prototype.showPopover = () => {};
let root: Root | undefined;
afterEach(() => {
  // Notifications outlive a render, so close this test's.
  for (const close of document.querySelectorAll<HTMLButtonElement>(
    '[aria-label="Notifications"] button[aria-label="Close"]',
  ))
    act(() => close.click());
  act(() => root?.unmount());
  root = undefined;
  document.body.innerHTML = "";
});

const at = new Date(2026, 9, 4, 15, 40).toISOString();
const time = new Date(at).toLocaleTimeString(undefined, { hour: "numeric", minute: "2-digit" });
const run = (over: Partial<AgentRun> = {}): AgentRun =>
  ({ id: "run", status: "waiting", resumeAt: at, ...over }) as AgentRun;
function render(r: AgentRun, disabledReason?: string) {
  root ??= createRoot(document.body.appendChild(document.createElement("div")));
  act(() =>
    root!.render(
      <>
        <ResumeCard hostId="local" run={r} disabledReason={disabledReason} />
        <Notifications />
      </>,
    ),
  );
}
/** The newest notification's title and body. */
const notice = () => {
  const n = document.querySelector('[aria-label="Notifications"] > div');
  return n && [n.querySelector("span")?.textContent, n.querySelector("p")?.textContent];
};
const button = (name: string) =>
  [...document.querySelectorAll("button")].find((b) => b.textContent === name)!;

test("a resume time today is the time alone, and another day's has its date first", () => {
  expect(resumeTime(at, new Date(2026, 9, 4, 9).getTime())).toBe(time);
  const tomorrow = resumeTime(at, new Date(2026, 9, 3, 9).getTime());
  expect(tomorrow).not.toBe(time);
  expect(tomorrow.endsWith(`, ${time}`)).toBe(true);
});

test("a resume time is in the OS's locale, which the bridge gives, not Chromium's default", () => {
  const tomorrow = () => resumeTime(at, new Date(2026, 9, 3, 9).getTime());
  window.parallax = { locale: "de-DE" } as Partial<ParallaxBridge> as ParallaxBridge;
  expect(tomorrow()).toBe("4. Okt., 15:40");
  window.parallax = { locale: "en-GB" } as Partial<ParallaxBridge> as ParallaxBridge;
  expect(tomorrow()).toBe("4 Oct, 15:40");
});

test("a waiting run says when it resumes", () => {
  render(run());
  expect(document.body.textContent).toContain(`Usage limit reached. Resumes at ${resumeTime(at)}`);
  render(run({ resumeAt: undefined }));
  expect(document.body.textContent).toContain("Usage limit reached. It resumes once it resets.");
});

test("Resume now and Cancel send their requests, and stay disabled while one is out", async () => {
  let answer: (value: unknown) => void = () => {};
  const request = vi.fn(() => new Promise((resolve) => (answer = resolve)));
  window.parallax = { request } as Partial<ParallaxBridge> as ParallaxBridge;
  render(run());
  act(() => button("Resume now").click());
  expect(request).toHaveBeenLastCalledWith("local", "agent/resumeNow", { runId: "run" });
  expect(button("Resume now").disabled).toBe(true);
  expect(button("Cancel").disabled).toBe(true);
  await act(async () => answer({ result: { run: run({ status: "running" }) } }));
  expect(button("Cancel").disabled).toBe(false);
  act(() => button("Cancel").click());
  expect(request).toHaveBeenLastCalledWith("local", "agent/cancel", { runId: "run" });
});

test("plxd's refusal shows in a notification, and a lost connection disables both buttons", async () => {
  const request = vi.fn(async () => ({
    error: { code: -32000, message: "run run isn't waiting for a usage limit to reset" },
  }));
  window.parallax = { request } as Partial<ParallaxBridge> as ParallaxBridge;
  render(run());
  await act(async () => button("Resume now").click());
  expect(notice()).toEqual([
    "Couldn't resume the thread",
    "run run isn't waiting for a usage limit to reset",
  ]);
  render(run(), "Disconnected from plxd");
  expect(button("Resume now").disabled).toBe(true);
  expect(button("Cancel").disabled).toBe(true);
});
