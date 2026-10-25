// The reasoning slider, as the desktop's EffortMenu draws it: a track with a stop for each level,
// an accent fill up to a white thumb that springs from stop to stop with a tick, stripes drifting
// through the fill faster the harder it thinks, and at Max a glow and a pop of the thumb. A drag
// or a tap picks the nearest stop, and each level's name sits under its stop.
import * as Haptics from "expo-haptics";
import { useEffect, useState } from "react";
import { StyleSheet, View } from "react-native";
import { Gesture, GestureDetector } from "react-native-gesture-handler";
import Animated, {
  cancelAnimation,
  Easing,
  useAnimatedStyle,
  useReducedMotion,
  useSharedValue,
  withRepeat,
  withSequence,
  withSpring,
  withTiming,
} from "react-native-reanimated";
import Svg, { Defs, LinearGradient, Pattern, Rect, Stop } from "react-native-svg";
import { scheduleOnRN } from "react-native-worklets";

import type { AgentEffort } from "../../desktop/src/protocol/generated/protocol";
import { effortLevels } from "../../desktop/src/renderer/catalog";
import { T, useColors } from "./ui";

const levels = effortLevels;
const last = levels.length - 1;
const THUMB = 44;
const TRACK = 36;
// One period of the fill's 45° stripes along the track, 16 px across them, as the desktop's.
const STRIPE = 16 * Math.SQRT2;
// A little overshoot, as the desktop's cubic-bezier(0.34, 1.56, 0.64, 1), so thumb and fill
// spring into place together.
const spring = { damping: 15, stiffness: 240, mass: 0.8 };

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
  const full = level === last;
  const [width, setWidth] = useState(0);
  const w = useSharedValue(0);
  // The thumb's center, and the stop it's at, on the UI thread.
  const x = useSharedValue(0);
  const stop = useSharedValue(level);
  const scale = useSharedValue(1);
  const stripes = useSharedValue(0);
  const glow = useSharedValue(0);

  // A level set from outside, as another provider's, springs there too.
  useEffect(() => {
    if (!width || stop.value === level) return;
    stop.value = level;
    x.value = withSpring(at(Math.max(level, 0), width), spring);
  }, [level, width]);

  // Stripes drift faster the harder it thinks, and Max glows and pops.
  const speed = levels[Math.max(level, 0)]!.speed;
  useEffect(() => {
    if (still) return;
    stripes.value = 0;
    stripes.value = withRepeat(withTiming(STRIPE, { duration: speed * 1000, easing: Easing.linear }), -1, false);
    return () => cancelAnimation(stripes);
  }, [speed, still]);
  useEffect(() => {
    if (!full || still) {
      cancelAnimation(glow);
      glow.value = 0;
      return;
    }
    scale.value = withSequence(withTiming(1.2, { duration: 180 }), withTiming(1, { duration: 270 }));
    glow.value = withRepeat(withTiming(1, { duration: 900, easing: Easing.inOut(Easing.ease) }), -1, true);
  }, [full, still]);

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
      scale.value = withTiming(0.9, { duration: 120 });
    })
    .onUpdate((e) => choose(e.x))
    .onFinalize(() => {
      scale.value = withSpring(1, spring);
    });
  const tap = Gesture.Tap().onEnd((e) => choose(e.x));

  const fill = useAnimatedStyle(() => ({ width: stop.value < 0 ? 0 : x.value }));
  const thumb = useAnimatedStyle(() => ({
    opacity: stop.value < 0 ? 0 : 1,
    transform: [{ translateX: x.value - THUMB / 2 }, { scale: scale.value }],
  }));
  const drift = useAnimatedStyle(() => ({ transform: [{ translateX: stripes.value }] }));
  const glowing = useAnimatedStyle(() => ({
    opacity: glow.value > 0 ? 1 : 0,
    shadowOpacity: 0.4 + glow.value * 0.3,
    shadowRadius: 6 + glow.value * 16,
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
          <Animated.View
            pointerEvents="none"
            style={[styles.track, styles.glow, { backgroundColor: c.accent, shadowColor: c.accent }, glowing]}
          />
          <View style={[styles.track, { backgroundColor: c.selected, borderColor: c.border }]}>
            <Animated.View style={[styles.fill, { backgroundColor: c.accent }, fill]}>
              {/* Lighter to the right, as the desktop's accent to 65% accent. */}
              <Svg style={StyleSheet.absoluteFill}>
                <Defs>
                  <LinearGradient id="lift" x1="0" y1="0" x2="1" y2="0">
                    <Stop offset="0" stopColor="#ffffff" stopOpacity={0} />
                    <Stop offset="1" stopColor="#ffffff" stopOpacity={0.35} />
                  </LinearGradient>
                </Defs>
                <Rect width="100%" height="100%" fill="url(#lift)" />
              </Svg>
              <Animated.View style={[styles.stripes, { width: width + STRIPE }, drift]}>
                <Svg width={width + STRIPE} height={TRACK}>
                  <Defs>
                    <Pattern id="stripes" width={16} height={16} patternUnits="userSpaceOnUse" patternTransform="rotate(45)">
                      <Rect width={8} height={16} fill="#ffffff" fillOpacity={0.13} />
                    </Pattern>
                  </Defs>
                  <Rect width="100%" height="100%" fill="url(#stripes)" />
                </Svg>
              </Animated.View>
            </Animated.View>
            {width > 0 &&
              levels.map((l, i) => (
                <View
                  key={l.value}
                  style={[
                    styles.dot,
                    { left: at(i, width) - 3 },
                    i < level ? { backgroundColor: "rgba(255, 255, 255, 0.6)" } : { backgroundColor: c.foreground, opacity: 0.35 },
                  ]}
                />
              ))}
          </View>
          <Animated.View pointerEvents="none" style={[styles.thumb, thumb]} />
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
              style={{ ...styles.name, left: at(i, width) - NAME / 2, ...(i === level && { color: c.foreground }) }}
            >
              {l.name}
            </T>
          ))}
      </View>
    </View>
  );
}

const NAME = 72;

const styles = StyleSheet.create({
  slider: { height: THUMB, justifyContent: "center" },
  track: {
    height: TRACK,
    borderRadius: TRACK / 2,
    borderWidth: StyleSheet.hairlineWidth,
    overflow: "hidden",
  },
  glow: { position: "absolute", top: (THUMB - TRACK) / 2, left: 0, right: 0, borderWidth: 0, overflow: "visible", shadowOffset: { width: 0, height: 0 } },
  // Square on the right, where the thumb covers it.
  fill: { position: "absolute", top: 0, bottom: 0, left: 0, borderTopLeftRadius: TRACK / 2, borderBottomLeftRadius: TRACK / 2, overflow: "hidden" },
  stripes: { position: "absolute", top: 0, bottom: 0, left: -STRIPE },
  dot: { position: "absolute", top: (TRACK - 6) / 2 - StyleSheet.hairlineWidth, width: 6, height: 6, borderRadius: 3 },
  thumb: {
    position: "absolute",
    left: 0,
    width: THUMB,
    height: THUMB,
    borderRadius: THUMB / 2,
    backgroundColor: "#ffffff",
    shadowColor: "#000000",
    shadowOpacity: 0.35,
    shadowRadius: 8,
    shadowOffset: { width: 0, height: 2 },
  },
  names: { height: 16, marginTop: 10 },
  name: { position: "absolute", width: NAME, textAlign: "center", fontSize: 11.5, lineHeight: 15 },
});
