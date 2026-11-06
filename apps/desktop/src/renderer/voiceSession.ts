export type VoicePhase = "idle" | "loading" | "recording" | "finishing";
export interface VoiceCapture {
  chunks: () => AsyncIterable<Float32Array>;
  waveform: () => Float32Array;
  finish: () => void;
  cancel: () => void;
}
export interface VoiceEngine {
  stream(
    chunks: AsyncIterable<Float32Array>,
    options: { abortSignal: AbortSignal },
  ): AsyncIterable<{ text: string }>;
  close: () => Promise<void>;
}
export interface VoiceDependencies {
  /** The transcript tidied up by a small model (PLX-1232). Without it, or if it fails, it's raw. */
  clean?: (text: string) => Promise<string>;
  engine(signal: AbortSignal): Promise<VoiceEngine>;
  capture(signal: AbortSignal): Promise<VoiceCapture>;
}
interface Recording {
  abort: AbortController;
  engine?: VoiceEngine;
  capture?: VoiceCapture;
  confirming: boolean;
  limit?: ReturnType<typeof setTimeout>;
}

/** One dictation belongs to one mounted composer. Cancellation invalidates late async results. */
export class VoiceSession {
  private active?: Recording;
  phase: VoicePhase = "idle";
  constructor(
    private readonly dependencies: VoiceDependencies,
    private readonly changed: (phase: VoicePhase) => void,
    private readonly inserted: (text: string) => void,
    private readonly failed: (error: unknown) => void,
  ) {}
  private setPhase(phase: VoicePhase) {
    this.phase = phase;
    this.changed(phase);
  }
  private async clean(raw: string): Promise<string> {
    try {
      return (await this.dependencies.clean?.(raw)) ?? raw;
    } catch {
      return raw;
    }
  }
  waveform = () => this.active?.capture?.waveform();
  start() {
    if (this.active) return;
    const recording: Recording = { abort: new AbortController(), confirming: false };
    this.active = recording;
    this.setPhase("loading");
    void this.run(recording);
  }
  confirm() {
    const recording = this.active;
    if (!recording || recording.confirming) return;
    // Releasing Fn during setup must never turn on a microphone later.
    if (!recording.capture) return this.cancel();
    recording.confirming = true;
    clearTimeout(recording.limit);
    this.setPhase("finishing");
    recording.capture.finish();
  }
  cancel() {
    const recording = this.active;
    if (!recording) return;
    this.active = undefined;
    clearTimeout(recording.limit);
    recording.abort.abort();
    recording.capture?.cancel();
    void recording.engine?.close().catch(() => {});
    this.setPhase("idle");
  }
  private async run(recording: Recording) {
    const { signal } = recording.abort;
    try {
      const engine = await this.dependencies.engine(signal);
      recording.engine = engine;
      if (signal.aborted) return;
      const capture = await this.dependencies.capture(signal);
      recording.capture = capture;
      if (signal.aborted) return;
      this.setPhase("recording");
      // Bound a forgotten mic session. Long dictation streams in one-second pieces.
      recording.limit = setTimeout(() => this.confirm(), 5 * 60_000);
      const parts: string[] = [];
      for await (const result of engine.stream(capture.chunks(), { abortSignal: signal })) {
        if (result.text.trim()) parts.push(result.text.trim());
      }
      if (this.active === recording && !signal.aborted && recording.confirming) {
        const raw = parts.join(" ");
        // The raw words go in when they can't be cleaned, so dictation never depends on a model.
        const text = raw ? await this.clean(raw) : raw;
        if (this.active === recording && !signal.aborted) this.inserted(text);
      }
    } catch (error) {
      if (this.active === recording && !signal.aborted) this.failed(error);
    } finally {
      clearTimeout(recording.limit);
      recording.capture?.cancel();
      await recording.engine?.close().catch(() => {});
      if (this.active === recording) {
        this.active = undefined;
        this.setPhase("idle");
      }
    }
  }
}
