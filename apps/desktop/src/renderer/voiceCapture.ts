import type { VoiceCapture } from "./voiceSession";

/** Capture and meter the same microphone stream. Nothing is sent off the device. */
export async function captureVoice(signal: AbortSignal): Promise<VoiceCapture> {
  if (!navigator.mediaDevices?.getUserMedia || !globalThis.AudioContext)
    throw new Error("Voice input needs a microphone and a secure app or browser connection.");
  const stream = await navigator.mediaDevices.getUserMedia({
    audio: { channelCount: 1, echoCancellation: true, noiseSuppression: true },
    video: false,
  });
  let context: AudioContext | undefined;
  let node: AudioWorkletNode | undefined;
  let closed = false;
  const queue: Float32Array[] = [];
  let ended = false;
  let failure: Error | undefined;
  let wake: (() => void) | undefined;
  let timer: ReturnType<typeof setTimeout> | undefined;
  const release = () => {
    if (closed) return;
    closed = true;
    clearTimeout(timer);
    stream.getTracks().forEach((track) => track.stop());
    node?.disconnect();
    node?.port.close();
    if (context) void context.close().catch(() => {});
    signal.removeEventListener("abort", cancel);
  };
  const end = () => {
    ended = true;
    release();
    wake?.();
  };
  const cancel = () => {
    queue.length = 0;
    end();
  };
  signal.addEventListener("abort", cancel, { once: true });
  try {
    signal.throwIfAborted();
    context = new AudioContext({ sampleRate: 16000 });
    if (context.sampleRate !== 16000) throw new Error("The microphone could not use 16 kHz audio.");
    await context.audioWorklet.addModule(new URL("./voiceCapture.worklet.js", import.meta.url));
    signal.throwIfAborted();
    const source = context.createMediaStreamSource(stream);
    const analyser = context.createAnalyser();
    analyser.fftSize = 1024;
    source.connect(analyser);
    node = new AudioWorkletNode(context, "parallax-voice");
    node.port.onmessage = ({ data }: MessageEvent<{ samples?: Float32Array; done?: boolean }>) => {
      if (ended) return;
      if (data.samples) queue.push(data.samples);
      if (data.done) end();
      wake?.();
    };
    node.onprocessorerror = () => {
      failure = new Error("The microphone stopped responding. Try voice input again.");
      end();
    };
    for (const track of stream.getAudioTracks()) {
      track.onended = () => {
        if (closed) return;
        failure = new Error("The microphone disconnected.");
        end();
      };
    }
    // The processor's output is silence. Connecting it keeps capture running without mic echo.
    source.connect(node);
    node.connect(context.destination);
    await context.resume();
    signal.throwIfAborted();
    const waveform = new Float32Array(analyser.fftSize);
    return {
      async *chunks() {
        while (!ended || queue.length > 0) {
          if (queue.length) yield queue.shift()!;
          else
            await new Promise<void>((resolve) => {
              wake = resolve;
            });
        }
        if (failure) throw failure;
      },
      waveform() {
        if (closed) waveform.fill(0);
        else analyser.getFloatTimeDomainData(waveform);
        return waveform;
      },
      finish() {
        if (closed) return;
        // Stop recording immediately, then flush the worklet's final partial second.
        stream.getTracks().forEach((track) => track.stop());
        node!.port.postMessage("finish");
        timer = setTimeout(() => {
          failure = new Error("The microphone could not finish recording. Try again.");
          end();
        }, 1500);
      },
      cancel,
    };
  } catch (error) {
    release();
    throw error;
  }
}
