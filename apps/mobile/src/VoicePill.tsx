// The recording pill, as the desktop's: the left check inserts what was said, the right stop
// discards it, and the waveform between them follows the microphone. It stands in for the message
// box, which stays mounted under it and keeps its text.
import { t } from "i18next";
import { Check } from "lucide-react-native";
import { useEffect, useState } from "react";
import { StyleSheet, View } from "react-native";
import Animated, { FadeIn, FadeOut } from "react-native-reanimated";

import { msg } from "../../desktop/src/i18n";
import type { VoicePhase } from "../../desktop/src/renderer/voiceSession";
import { SendButton } from "./SendButton";
import { useColors, WorkingMark } from "./ui";

/** What each phase says to a screen reader, shown with `t`. */
const statuses: Record<VoicePhase, string> = {
  idle: "",
  loading: msg("Preparing voice input"),
  recording: msg("Listening"),
  finishing: msg("Transcribing"),
};

const BARS = 25;
const BAR_WIDTH = 3;
const BAR_STEP = 5;
const HEIGHT = 24;
const STEP_MS = 60;

/** The microphone's level over the last moment, the newest at the center, spreading outward. */
function Waveform({ waveform }: { waveform: () => Float32Array | undefined }) {
  const c = useColors();
  const [levels, setLevels] = useState(() => Array.from({ length: Math.ceil(BARS / 2) }, () => 0));
  useEffect(() => {
    const timer = setInterval(
      () => setLevels((now) => [waveform()?.[0] ?? 0, ...now.slice(0, -1)]),
      STEP_MS,
    );
    return () => clearInterval(timer);
  }, [waveform]);
  const center = Math.floor(BARS / 2);
  return (
    <View style={styles.bars}>
      {Array.from({ length: BARS }, (_, bar) => {
        const away = Math.abs(bar - center);
        return (
          <View
            key={bar}
            style={{
              width: BAR_WIDTH,
              height: BAR_WIDTH + (levels[away] ?? 0) * (HEIGHT - BAR_WIDTH),
              borderRadius: BAR_WIDTH / 2,
              backgroundColor: c.foreground,
              // Fades toward the ends, so the row trails off instead of stopping at a wall.
              opacity: 1 - (away / center) * 0.6,
            }}
          />
        );
      })}
    </View>
  );
}

export function VoicePill({
  phase,
  waveform,
  confirm,
  cancel,
  bottom,
}: {
  phase: VoicePhase;
  waveform: () => Float32Array | undefined;
  confirm: () => void;
  cancel: () => void;
  /** How far over the screen's foot the message box sits. */
  bottom: number;
}) {
  const c = useColors();
  return (
    <Animated.View
      entering={FadeIn.duration(180)}
      exiting={FadeOut.duration(120)}
      pointerEvents="box-none"
      style={[styles.holder, { bottom }]}
    >
      <View
        accessibilityLabel={statuses[phase] && t(statuses[phase])}
        style={[styles.pill, { backgroundColor: c.surface, borderColor: c.border }]}
      >
        <SendButton icon={Check} label={t("Insert transcription")} disabled={phase !== "recording"} onPress={confirm} />
        {phase === "recording" ? (
          <Waveform waveform={waveform} />
        ) : (
          // Not listening yet, or any more: the app's working mark, where the bars go.
          <View style={[styles.bars, { justifyContent: "center" }]}>
            <WorkingMark size={20} />
          </View>
        )}
        <SendButton stop label={t("Cancel voice input")} onPress={cancel} />
      </View>
    </Animated.View>
  );
}

const styles = StyleSheet.create({
  holder: { position: "absolute", left: 0, right: 0, alignItems: "center" },
  pill: {
    flexDirection: "row",
    alignItems: "center",
    gap: 10,
    padding: 6,
    borderWidth: 1,
    borderRadius: 26,
    borderCurve: "continuous",
  },
  bars: {
    width: BARS * BAR_STEP - (BAR_STEP - BAR_WIDTH),
    height: HEIGHT,
    flexDirection: "row",
    alignItems: "center",
    justifyContent: "space-between",
  },
});
