/* global AudioWorkletProcessor, registerProcessor */
// Keep capture off the renderer thread. Each transfer is one second of mono PCM.
class VoiceCapture extends AudioWorkletProcessor {
  constructor() {
    super();
    this.samples = new Float32Array(sampleRate);
    this.used = 0;
    this.stopped = false;
    this.port.onmessage = () => {
      this.flush();
      this.stopped = true;
      this.port.postMessage({ done: true });
    };
  }
  flush() {
    if (!this.used) return;
    const samples = this.samples.slice(0, this.used);
    this.port.postMessage({ samples }, [samples.buffer]);
    this.used = 0;
  }
  process(inputs) {
    if (this.stopped) return false;
    const channels = inputs[0];
    if (!channels?.length) return true;
    for (let i = 0; i < channels[0].length; i++) {
      let value = 0;
      for (const channel of channels) value += channel[i] ?? 0;
      // Web Audio gain/AEC can exceed unity. Whistle accepts finite normalized PCM only.
      const mixed = value / channels.length;
      this.samples[this.used++] = Number.isFinite(mixed) ? Math.max(-1, Math.min(1, mixed)) : 0;
      if (this.used === this.samples.length) this.flush();
    }
    return true;
  }
}
registerProcessor("parallax-voice", VoiceCapture);
