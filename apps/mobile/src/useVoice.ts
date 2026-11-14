// A composer's dictation: the desktop's VoiceSession over iOS speech recognition (speech.ts).
import { t } from "i18next";
import { useEffect, useRef, useState } from "react";
import { AppState, Linking } from "react-native";

import { VoiceSession, type VoicePhase } from "../../desktop/src/renderer/voiceSession";
import { showAlert } from "./dialogStore";
import { SpeechDenied, speechDependencies } from "./speech";

function voiceFailed(error: unknown) {
  if (error instanceof SpeechDenied)
    return showAlert(t("Dictation is off for Parallax"), t("Allow the microphone and speech recognition in Settings to dictate."), [
      { text: t("Not now"), style: "cancel" },
      { text: t("Open Settings"), onPress: () => void Linking.openSettings() },
    ]);
  showAlert(t("Dictation failed"), error instanceof Error ? error.message : t("Try again."));
}

/**
 * One dictation at a time for this composer. `inserted` gets the transcript, tidied by `clean`,
 * where any failure inserts it raw. Leaving the app, or the composer going away, cancels it.
 */
export function useVoice(options: { inserted: (text: string) => void; clean: (text: string) => Promise<string> }) {
  const latest = useRef(options);
  latest.current = options;
  const [phase, setPhase] = useState<VoicePhase>("idle");
  const [session] = useState(() => {
    const voice: VoiceSession = new VoiceSession(
      {
        ...speechDependencies(() => voice.confirm()),
        clean: (text) => latest.current.clean(text),
      },
      setPhase,
      (text) => {
        if (text) latest.current.inserted(text);
      },
      voiceFailed,
    );
    return voice;
  });
  useEffect(() => {
    // Not "inactive", which is also iOS asking for permission over the app.
    const left = AppState.addEventListener("change", (state) => {
      if (state === "background" && session.phase !== "finishing") session.cancel();
    });
    return () => {
      left.remove();
      session.cancel();
    };
  }, [session]);
  return {
    phase,
    start: () => session.start(),
    confirm: () => session.confirm(),
    cancel: () => session.cancel(),
    waveform: session.waveform,
  };
}
