import { beforeEach, describe, expect, it, vi } from "vitest";

import { VoiceSession } from "../../desktop/src/renderer/voiceSession";
import { speechDependencies } from "./speech";

const native = vi.hoisted(() => {
  const listeners = new Map<string, (event: unknown) => void>();
  return {
    listeners,
    module: {
      requestPermissionsAsync: vi.fn(async () => ({ granted: true })),
      supportsOnDeviceRecognition: () => true,
      addListener: (name: string, listener: (event: unknown) => void) => {
        listeners.set(name, listener);
        return { remove: () => listeners.delete(name) };
      },
      start: vi.fn(),
      stop: vi.fn(),
      abort: vi.fn(),
    },
  };
});
vi.mock("expo-speech-recognition", () => ({ ExpoSpeechRecognitionModule: native.module }));

const started = () => vi.waitFor(() => expect(native.module.start).toHaveBeenCalled());

function session() {
  const voice: VoiceSession = new VoiceSession(speechDependencies(() => voice.confirm()), () => {}, () => {}, () => {});
  return voice;
}

describe("dictation on iOS", () => {
  beforeEach(() => vi.clearAllMocks());

  it("turns the microphone off when a recording is cancelled", async () => {
    const voice = session();
    voice.start();
    await started();
    native.listeners.get("start")!(null);
    await vi.waitFor(() => expect(voice.phase).toBe("recording"));
    voice.cancel();
    expect(native.module.abort).toHaveBeenCalledOnce();
  });

  it("turns the microphone off when cancelled before iOS has started", async () => {
    const voice = session();
    voice.start();
    await started();
    voice.cancel();
    expect(native.module.abort).toHaveBeenCalledOnce();
  });
});
