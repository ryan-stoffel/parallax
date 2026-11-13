// iOS speech recognition as the engine and microphone the desktop's VoiceSession takes. iOS does
// both at once, so the "engine" only waits for what the recognition heard. Recognition stays on the
// phone where iOS supports that for its language, and otherwise goes to Apple.
import { ExpoSpeechRecognitionModule as Speech } from "expo-speech-recognition";
import { t } from "i18next";

import type { VoiceCapture, VoiceDependencies, VoiceEngine } from "../../desktop/src/renderer/voiceSession";
import { Heard } from "./speechText";

/** The microphone or speech recognition is turned off for Parallax in Settings. */
export class SpeechDenied extends Error {}

/** One recording, from asking iOS to start to the transcript. */
class Recognition implements VoiceEngine {
  private heard = new Heard();
  private level = 0;
  private over = false;
  /** iOS is already ending the recording, so there's nothing to stop. */
  private ending = false;
  private listeners: { remove: () => void }[] = [];
  private finish!: (text: string) => void;
  private fail!: (error: Error) => void;
  private finished = new Promise<string>((resolve, reject) => {
    this.finish = resolve;
    this.fail = reject;
  });

  constructor(private readonly ended: () => void) {
    // Read by `stream`, which a failure before recording never reaches.
    this.finished.catch(() => {});
  }

  /** Starts listening, once it's allowed. Resolves when iOS has started. */
  async listen(signal: AbortSignal): Promise<VoiceCapture> {
    const { granted } = await Speech.requestPermissionsAsync();
    if (!granted) throw new SpeechDenied();
    // Not `throwIfAborted`, which React Native's AbortSignal lacks.
    if (signal.aborted) throw new Error(t("Dictation was cancelled."));
    await new Promise<void>((started, refused) => {
      signal.addEventListener(
        "abort",
        () => {
          this.abandon();
          refused(new Error(t("Dictation was cancelled.")));
        },
        { once: true },
      );
      this.listeners = [
        Speech.addListener("start", () => started()),
        Speech.addListener("result", (e) => this.heard.add(e.results[0]?.transcript ?? "", e.isFinal)),
        Speech.addListener("volumechange", ({ value }) => {
          // iOS reports -2 to 10, with anything below 0 inaudible.
          this.level = Math.min(1, Math.max(0, value / 10));
        }),
        Speech.addListener("error", ({ error, message }) => {
          // Stopping with nothing said isn't a failure: there's just nothing to insert.
          if (error === "aborted" || error === "no-speech") return;
          const failure = error === "not-allowed" ? new SpeechDenied() : new Error(message);
          this.settle(failure);
          refused(failure);
        }),
        Speech.addListener("end", () => {
          // iOS can end a recording itself, as Apple's service does after about a minute. What was
          // said still goes in, as when the user confirms.
          this.ending = true;
          if (!this.over) this.ended();
          this.settle();
        }),
      ];
      Speech.start({
        lang: Intl.DateTimeFormat().resolvedOptions().locale,
        interimResults: true,
        continuous: true,
        addsPunctuation: true,
        requiresOnDeviceRecognition: Speech.supportsOnDeviceRecognition(),
        iosTaskHint: "dictation",
        volumeChangeEventOptions: { enabled: true, intervalMillis: 50 },
      });
    });
    return {
      chunks: async function* () {},
      waveform: () => Float32Array.of(this.level),
      finish: () => {
        if (!this.over && !this.ending) Speech.stop();
      },
      cancel: () => this.abandon(),
    };
  }

  async *stream(): AsyncIterable<{ text: string }> {
    yield { text: await this.finished };
  }

  close = async () => this.settle();

  /** Turns the microphone off and drops what was heard. */
  private abandon() {
    if (!this.over) Speech.abort();
    this.settle();
  }

  /** Ends this recording once: with `failure`, or with what was heard. */
  private settle(failure?: Error) {
    if (this.over) return;
    this.over = true;
    for (const listener of this.listeners) listener.remove();
    if (failure) this.fail(failure);
    else this.finish(this.heard.text);
  }
}

/** VoiceSession's engine and capture. `ended` is called when iOS ends a recording itself. */
export function speechDependencies(ended: () => void): Pick<VoiceDependencies, "engine" | "capture"> {
  let recognition: Recognition;
  return {
    engine: async () => (recognition = new Recognition(ended)),
    capture: (signal) => recognition.listen(signal),
  };
}
