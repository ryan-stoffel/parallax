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
    voice = useVoice({
      enabled: true,
      focused: true,
      hotkey: true,
      scope: "thread-1",
      starting,
      inserted,
    });
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

test("only the focused split composer owns Fn and a focus switch cancels its old recording", async () => {
  const listeners = new Set<(key: VoiceKey) => void>();
  let nativeOwner: string | undefined;
  const native = vi.fn(async (enabled: boolean, owner: string) => {
    if (enabled) nativeOwner = owner;
    else if (nativeOwner === owner) nativeOwner = undefined;
    return { available: true };
  });
  window.parallax = {
    voiceHotkey: native,
    onVoiceKey: (callback: (key: VoiceKey) => void) => {
      listeners.add(callback);
      return () => {
        listeners.delete(callback);
      };
    },
  } as unknown as ParallaxBridge;
  const inserted = [vi.fn(), vi.fn()];
  const started = [vi.fn(), vi.fn()];
  const phases: ReturnType<typeof useVoice>[] = [];
  function Tile({ id, focused }: { id: number; focused: boolean }) {
    phases[id] = useVoice({
      enabled: true,
      focused,
      hotkey: true,
      scope: `thread-${id}`,
      starting: started[id]!,
      inserted: inserted[id]!,
    });
    return <div className="composer-input" contentEditable suppressContentEditableWarning />;
  }
  function Split({ focused, hideLeft = false }: { focused: number; hideLeft?: boolean }) {
    return (
      <>
        {!hideLeft && <Tile key="left" id={0} focused={focused === 0} />}
        <Tile key="right" id={1} focused={focused === 1} />
      </>
    );
  }
  const key = async (value: VoiceKey) => {
    await act(async () => {
      for (const listener of listeners) listener(value);
      for (let i = 0; i < 15; i++) await Promise.resolve();
    });
  };
  const container = document.body.appendChild(document.createElement("div"));
  const root = createRoot(container);
  try {
    await act(async () => root.render(<Split focused={0} />));
    expect(listeners.size).toBe(1);
    await key("down");
    expect(phases[0]!.phase).toBe("recording");
    expect(started[1]).not.toHaveBeenCalled();
    await act(async () => root.render(<Split focused={1} />));
    expect(phases[0]!.phase).toBe("idle");
    expect(listeners.size).toBe(1);
    const rightOwner = nativeOwner;
    expect(rightOwner).toBeTruthy();
    await key("up");
    expect(inserted[0]).not.toHaveBeenCalled();
    await act(async () => root.render(<Split focused={1} hideLeft />));
    expect(nativeOwner).toBe(rightOwner);
    await key("down");
    await key("up");
    expect(inserted[1]).toHaveBeenCalledExactlyOnceWith("hello");
    expect(inserted[0]).not.toHaveBeenCalled();
  } finally {
    await act(async () => root.unmount());
    container.remove();
  }
});
