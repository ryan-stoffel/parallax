// @vitest-environment happy-dom
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, expect, test, vi } from "vite-plus/test";

import type { ParallaxBridge } from "../preload/bridge";
import type { AgentRun } from "../protocol/generated/protocol";
import { ResumeCard, resumeTime } from "./ResumeCard";

Object.assign(globalThis, { IS_REACT_ACT_ENVIRONMENT: true });
let root: Root | undefined;
afterEach(() => {
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
  act(() => root!.render(<ResumeCard hostId="local" run={r} disabledReason={disabledReason} />));
}
const button = (name: string) =>
  [...document.querySelectorAll("button")].find((b) => b.textContent === name)!;

test("a resume time today is the time alone, and another day's has its date first", () => {
  expect(resumeTime(at, new Date(2026, 9, 4, 9).getTime())).toBe(time);
  const tomorrow = resumeTime(at, new Date(2026, 9, 3, 9).getTime());
  expect(tomorrow).not.toBe(time);
  expect(tomorrow.endsWith(`, ${time}`)).toBe(true);
});

test("a waiting run says when it resumes, and a run that isn't waiting shows nothing", () => {
  render(run());
  expect(document.body.textContent).toContain(`Usage limit reached. Resumes at ${resumeTime(at)}`);
  render(run({ resumeAt: undefined }));
  expect(document.body.textContent).toContain("Usage limit reached. It resumes once it resets.");
  render(run({ status: "running", resumeAt: undefined }));
  expect(document.body.textContent).toBe("");
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

test("plxd's refusal shows on the card, and a lost connection disables both buttons", async () => {
  const request = vi.fn(async () => ({
    error: { code: -32000, message: "run run isn't waiting for a usage limit to reset" },
  }));
  window.parallax = { request } as Partial<ParallaxBridge> as ParallaxBridge;
  render(run());
  await act(async () => button("Resume now").click());
  expect(document.querySelector('[role="alert"]')?.textContent).toBe(
    "run run isn't waiting for a usage limit to reset",
  );
  render(run(), "Disconnected from plxd");
  expect(button("Resume now").disabled).toBe(true);
  expect(button("Cancel").disabled).toBe(true);
});
