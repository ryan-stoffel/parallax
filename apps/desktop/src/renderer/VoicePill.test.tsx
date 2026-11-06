// @vitest-environment happy-dom
import { act } from "react";
import { createRoot } from "react-dom/client";
import { expect, test, vi } from "vite-plus/test";
import { voiceLevel, VoicePill } from "./VoicePill";

Object.assign(globalThis, { IS_REACT_ACT_ENVIRONMENT: true });
// Without motion, the pill takes its end state at once.
document.documentElement.classList.add("reduce-motion");

test("the level is nothing at silence, rises with the signal, and tops out at 1", () => {
  const frame = (value: number) => new Float32Array(1024).fill(value);
  expect(voiceLevel(undefined)).toBe(0);
  expect(voiceLevel(frame(0))).toBe(0);
  expect(voiceLevel(frame(0.002))).toBe(0);
  expect(voiceLevel(frame(0.05))).toBeGreaterThan(voiceLevel(frame(0.02)));
  expect(voiceLevel(frame(1))).toBe(1);
});

test("the pill shows no text, its check before its stop, and leaves once the session ends", async () => {
  const confirm = vi.fn();
  const cancel = vi.fn();
  const host = document.body.appendChild(document.createElement("div"));
  const root = createRoot(host);
  const pill = (phase: "recording" | "idle") => (
    <VoicePill
      phase={phase}
      waveform={() => undefined}
      confirm={confirm}
      cancel={cancel}
      anchor={{ current: null }}
    />
  );
  await act(async () => root.render(pill("recording")));
  const buttons = [...host.querySelectorAll("button")];
  expect(buttons.map((b) => b.getAttribute("aria-label"))).toEqual([
    "Insert transcription",
    "Cancel voice input",
  ]);
  // Only the status, which only a screen reader reads.
  expect(host.textContent).toBe("Listening");
  expect(host.querySelector('[role="status"]')!.className).toContain("sr-only");
  await act(async () => buttons[0]!.click());
  await act(async () => buttons[1]!.click());
  expect(confirm).toHaveBeenCalledOnce();
  expect(cancel).toHaveBeenCalledOnce();
  await act(async () => root.render(pill("idle")));
  expect(host.textContent).toBe("");
  await act(async () => root.unmount());
});
