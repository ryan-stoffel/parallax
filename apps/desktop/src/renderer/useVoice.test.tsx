// @vitest-environment happy-dom
import { act } from "react";
import { createRoot } from "react-dom/client";
import { expect, test, vi } from "vite-plus/test";
import type { ParallaxBridge, VoiceKey } from "../preload/bridge";
import { useVoice } from "./useVoice";

const fake = vi.hoisted(() => ({ finish: () => {}, cancel: vi.fn() }));
vi.mock("./voiceEngine", () => ({
  loadVoiceEngine: async () => ({
    async *stream() {
      await new Promise<void>((resolve) => {
        fake.finish = resolve;
      });
      yield { text: "hello" };
    },
    close: async () => {},
  }),
}));
vi.mock("./voiceCapture", () => ({
  captureVoice: async () => ({
    async *chunks() {
      yield new Float32Array(1);
    },
    waveform: () => new Float32Array(1),
    finish: () => fake.finish(),
    cancel: fake.cancel,
  }),
}));
vi.mock(import("./notifications"), () => ({ notify: vi.fn() }));
Object.assign(globalThis, { IS_REACT_ACT_ENVIRONMENT: true });

test("held Fn ignores hidden menus and inserts on release, then cancels on window blur", async () => {
  let key!: (key: VoiceKey) => void;
  const inserted = vi.fn();
  const starting = vi.fn();
  window.parallax = {
    voiceHotkey: async () => ({ available: true }),
    onVoiceKey: (callback: (key: VoiceKey) => void) => {
      key = callback;
      return () => {};
    },
  } as unknown as ParallaxBridge;
  const hidden = document.body.appendChild(document.createElement("div"));
  hidden.setAttribute("role", "menu");
  hidden.hidden = true;
  hidden.checkVisibility = () => false;
  let voice!: ReturnType<typeof useVoice>;
  function Probe() {
    voice = useVoice({ enabled: true, hotkey: true, scope: "thread-1", starting, inserted });
    return null;
  }
  const container = document.body.appendChild(document.createElement("div"));
  const root = createRoot(container);
  try {
    await act(async () => root.render(<Probe />));
    await act(async () => {
      key("down");
      for (let i = 0; i < 15; i++) await Promise.resolve();
    });
    expect(starting).toHaveBeenCalledOnce();
    expect(voice.phase).toBe("recording");
    await act(async () => key("up"));
    expect(inserted).toHaveBeenCalledExactlyOnceWith("hello");
    await act(async () => {
      key("down");
      for (let i = 0; i < 15; i++) await Promise.resolve();
    });
    await act(async () => window.dispatchEvent(new Event("blur")));
    expect(voice.phase).toBe("idle");
    expect(fake.cancel).toHaveBeenCalled();
    expect(inserted).toHaveBeenCalledOnce();
  } finally {
    await act(async () => root.unmount());
    container.remove();
    hidden.remove();
  }
});
