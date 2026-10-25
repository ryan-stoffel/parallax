// The reasoning slider: a slim track with a stop for each level, an accent fill up to a white
// thumb that springs from stop to stop with a tick, and each level's name under its stop. A drag
// or a tap picks the nearest stop. At Max the thumb pops.
import * as Haptics from "expo-haptics";
import { useEffect, useState } from "react";
import { StyleSheet, View } from "react-native";
import { Gesture, GestureDetector } from "react-native-gesture-handler";
import Animated, {
  useAnimatedStyle,
  useReducedMotion,
  useSharedValue,
  withSequence,
  withSpring,
  withTiming,
} from "react-native-reanimated";
import { scheduleOnRN } from "react-native-worklets";

import type { AgentEffort } from "../../desktop/src/protocol/generated/protocol";
import { effortLevels } from "../../desktop/src/renderer/catalog";
import { T, useColors } from "./ui";

const levels = effortLevels;
const last = levels.length - 1;
const THUMB = 28;
const TRACK = 6;
// The height a touch lands in, taller than the thumb.
const HIT = 40;
// A little overshoot, so thumb and fill spring into place together.
const spring = { damping: 16, stiffness: 260, mass: 0.7 };

/** Stop `i`'s center on a track `width` wide: the thumb's center goes from one radius in to one short. */
function at(i: number, width: number) {
  "worklet";
  return THUMB / 2 + ((width - THUMB) * i) / last;
}

/** The slider for `value`, none chosen while it's undefined, which `onChange` sets. */
export function EffortSlider({
  value,
  onChange,
}: {
  value?: AgentEffort;
  onChange: (value: AgentEffort) => void;
}) {
  const c = useColors();
  const still = useReducedMotion();
  const level = levels.findIndex((l) => l.value === value);
  const [width, setWidth] = useState(0);
  const w = useSharedValue(0);
  // The thumb's center, and the stop it's at, on the UI thread.
  const x = useSharedValue(0);
  const stop = useSharedValue(level);
  const scale = useSharedValue(1);

  // A level set from outside, as another provider's, springs there too.
  useEffect(() => {
    if (!width || stop.value === level) return;
    stop.value = level;
    x.value = withSpring(at(Math.max(level, 0), width), spring);
  }, [level, width]);

  // Max pops the thumb once.
  useEffect(() => {
    if (level === last && !still)
      scale.value = withSequence(withTiming(1.18, { duration: 160 }), withSpring(1, spring));
  }, [level, still]);

  const pick = (i: number) => {
    void Haptics.selectionAsync();
    onChange(levels[i]!.value);
  };
  /** Moves to the stop nearest `px` across the track, with a tick when it's another. */
  const choose = (px: number) => {
    "worklet";
    if (!w.value) return;
    const i = Math.round(Math.min(Math.max((px - THUMB / 2) / (w.value - THUMB), 0), 1) * last);
    if (i === stop.value) return;
    stop.value = i;
    x.value = withSpring(at(i, w.value), spring);
    scheduleOnRN(pick, i);
  };
  const pan = Gesture.Pan()
    .activeOffsetX([-4, 4])
    .failOffsetY([-12, 12])
    .onBegin(() => {
      scale.value = withTiming(1.12, { duration: 120 });
    })
    .onUpdate((e) => choose(e.x))
    .onFinalize(() => {
      scale.value = withSpring(1, spring);
    });
  const tap = Gesture.Tap().onEnd((e) => choose(e.x));

  // The fill runs under the thumb's center, so its end hides behind it.
  const fill = useAnimatedStyle(() => ({ width: stop.value < 0 ? 0 : x.value + TRACK / 2 }));
  const thumb = useAnimatedStyle(() => ({
    opacity: stop.value < 0 ? 0 : 1,
    transform: [{ translateX: x.value - THUMB / 2 }, { scale: scale.value }],
  }));

  return (
    <View>
      <GestureDetector gesture={Gesture.Race(pan, tap)}>
        <View
          accessible
          accessibilityRole="adjustable"
          accessibilityLabel="Reasoning effort"
          accessibilityValue={{ text: levels[level]?.name ?? "Default" }}
          accessibilityActions={[{ name: "increment" }, { name: "decrement" }]}
          onAccessibilityAction={(e) => {
            const i = Math.min(Math.max(level + (e.nativeEvent.actionName === "increment" ? 1 : -1), 0), last);
            if (i !== level) pick(i);
          }}
          onLayout={(e) => {
            const next = e.nativeEvent.layout.width;
            w.value = next;
            x.value = at(Math.max(level, 0), next);
            stop.value = level;
            setWidth(next);
          }}
          style={styles.slider}
        >
          <View style={[styles.track, { backgroundColor: c.border }]}>
            <Animated.View style={[styles.fill, { backgroundColor: c.accent }, fill]} />
          </View>
          {width > 0 &&
            levels.map((l, i) => (
              <View
                key={l.value}
                pointerEvents="none"
                style={[
                  styles.stop,
                  { left: at(i, width) - STOP / 2 },
                  { backgroundColor: i <= level ? c.accent : c.background, borderColor: i <= level ? c.accent : c.border },
                ]}
              />
            ))}
          <Animated.View pointerEvents="none" style={[styles.thumb, { borderColor: c.border }, thumb]} />
        </View>
      </GestureDetector>
      <View style={styles.names}>
        {width > 0 &&
          levels.map((l, i) => (
            <T
              key={l.value}
              medium={i === level}
              faint={i !== level}
              numberOfLines={1}
              style={{ ...styles.name, left: at(i, width) - NAME / 2, ...(i === level && { color: c.accent }) }}
            >
              {l.name}
            </T>
          ))}
      </View>
    </View>
  );
}

const NAME = 72;
const STOP = 10;

const styles = StyleSheet.create({
  slider: { height: HIT, justifyContent: "center" },
  track: { height: TRACK, borderRadius: TRACK / 2, marginHorizontal: THUMB / 2 - TRACK / 2, overflow: "hidden" },
  fill: { position: "absolute", top: 0, bottom: 0, left: 0, borderRadius: TRACK / 2 },
  stop: {
    position: "absolute",
    top: (HIT - STOP) / 2,
    width: STOP,
    height: STOP,
    borderRadius: STOP / 2,
    borderWidth: 1.5,
  },
  thumb: {
    position: "absolute",
    top: (HIT - THUMB) / 2,
    left: 0,
    width: THUMB,
    height: THUMB,
    borderRadius: THUMB / 2,
    backgroundColor: "#ffffff",
    borderWidth: StyleSheet.hairlineWidth,
    shadowColor: "#000000",
    shadowOpacity: 0.18,
    shadowRadius: 6,
    shadowOffset: { width: 0, height: 2 },
  },
  names: { height: 16, marginTop: 6 },
  name: { position: "absolute", width: NAME, textAlign: "center", fontSize: 12, lineHeight: 15 },
});
