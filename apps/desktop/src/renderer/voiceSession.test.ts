import { expect, test, vi } from "vite-plus/test";
import { VoiceSession, type VoiceCapture, type VoiceEngine, type VoicePhase } from "./voiceSession";

function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((done) => {
    resolve = done;
  });
  return { promise, resolve };
}
async function settle() {
  for (let i = 0; i < 8; i++) await Promise.resolve();
}
function fixture() {
  const finish = deferred<void>();
  const close = vi.fn(async () => {});
  const capture: VoiceCapture = {
    async *chunks() {
      await finish.promise;
      yield new Float32Array([0.1]);
    },
    waveform: () => new Float32Array([0.1]),
    finish: vi.fn(() => finish.resolve()),
    cancel: vi.fn(() => finish.resolve()),
  };
  const engine: VoiceEngine = {
    async *stream(chunks) {
      for await (const _ of chunks) yield { text: "hello world" };
    },
    close,
  };
  const inserted = vi.fn();
  const failed = vi.fn();
  const phases: VoicePhase[] = [];
  const dependencies = { engine: vi.fn(async () => engine), capture: vi.fn(async () => capture) };
  const session = new VoiceSession(dependencies, (phase) => phases.push(phase), inserted, failed);
  return { session, dependencies, capture, engine, inserted, failed, phases };
}
test("confirmation inserts the captured transcript once, after final audio flush", async () => {
  const f = fixture();
  f.session.start();
  await settle();
  expect(f.session.phase).toBe("recording");
  expect(f.session.waveform()?.[0]).toBeCloseTo(0.1);
  f.session.confirm();
  f.session.confirm();
  await settle();
  expect(f.capture.finish).toHaveBeenCalledTimes(1);
  expect(f.inserted).toHaveBeenCalledExactlyOnceWith("hello world");
  expect(f.phases).toEqual(["loading", "recording", "finishing", "idle"]);
  expect(f.engine.close).toHaveBeenCalled();
});
test("Fn release while loading never asks for microphone access", async () => {
  const f = fixture();
  const pending = deferred<VoiceEngine>();
  f.dependencies.engine.mockReturnValueOnce(pending.promise);
  f.session.start();
  f.session.confirm();
  pending.resolve(f.engine);
  await settle();
  expect(f.dependencies.capture).not.toHaveBeenCalled();
  expect(f.inserted).not.toHaveBeenCalled();
  expect(f.session.phase).toBe("idle");
  expect(f.engine.close).toHaveBeenCalled();
});
test("cancellation while microphone permission is pending disposes a late capture", async () => {
  const f = fixture();
  const pending = deferred<VoiceCapture>();
  f.dependencies.capture.mockReturnValueOnce(pending.promise);
  f.session.start();
  await settle();
  f.session.cancel();
  pending.resolve(f.capture);
  await settle();
  expect(f.capture.cancel).toHaveBeenCalled();
  expect(f.inserted).not.toHaveBeenCalled();
  expect(f.session.phase).toBe("idle");
});
test("discarding final transcription cannot overwrite a later recording", async () => {
  const f = fixture();
  const old = deferred<void>();
  f.engine.stream = async function* () {
    await old.promise;
    yield { text: "stale" };
  };
  f.session.start();
  await settle();
  f.session.confirm();
  f.session.cancel();
  const next = fixture();
  f.dependencies.engine.mockResolvedValueOnce(next.engine);
  f.dependencies.capture.mockResolvedValueOnce(next.capture);
  f.session.start();
  await settle();
  old.resolve();
  await settle();
  expect(f.inserted).not.toHaveBeenCalled();
  expect(f.session.phase).toBe("recording");
  f.session.cancel();
});
test("recording errors clean up without inserting or retaining the microphone", async () => {
  const f = fixture();
  f.engine.stream = async function* () {
    yield await Promise.reject(new Error("microphone disconnected"));
  };
  f.session.start();
  await settle();
  expect(f.failed).toHaveBeenCalledOnce();
  expect(f.capture.cancel).toHaveBeenCalled();
  expect(f.inserted).not.toHaveBeenCalled();
  expect(f.session.phase).toBe("idle");
});
