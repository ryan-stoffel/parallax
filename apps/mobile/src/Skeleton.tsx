// A transcript's stand-in while it loads: the shapes of a short conversation, the user's bubbles
// and the agent's lines and a step, in the theme's quiet fills, breathing slowly. With Reduce
// Motion on, it holds still.
import { useEffect } from "react";
import { StyleSheet, View, type DimensionValue } from "react-native";
import Animated, {
  Easing,
  useAnimatedStyle,
  useReducedMotion,
  useSharedValue,
  withRepeat,
  withTiming,
} from "react-native-reanimated";

import { useColors } from "./ui";

/** A rounded bar `width` wide. */
function Bar({ width, height = 12, color }: { width: DimensionValue; height?: number; color: string }) {
  return <View style={{ width, height, borderRadius: height / 2, backgroundColor: color }} />;
}

/** The transcript's skeleton, from the top as the transcript starts. */
export function TranscriptSkeleton() {
  const c = useColors();
  const still = useReducedMotion();
  const pulse = useSharedValue(1);
  useEffect(() => {
    if (!still) pulse.value = withRepeat(withTiming(0.45, { duration: 900, easing: Easing.inOut(Easing.ease) }), -1, true);
  }, [still]);
  const breathe = useAnimatedStyle(() => ({ opacity: pulse.value }));
  const fill = c.selected;
  const agent = (widths: DimensionValue[]) => (
    <View style={{ gap: 10 }}>
      {widths.map((w, i) => (
        <Bar key={i} width={w} color={fill} />
      ))}
    </View>
  );
  return (
    <Animated.View
      accessible
      accessibilityLabel="Loading the thread"
      accessibilityRole="progressbar"
      style={[styles.column, breathe]}
    >
      <View style={[styles.bubble, { width: "62%", backgroundColor: fill }]} />
      <View style={styles.trace}>
        <View style={[styles.dot, { backgroundColor: fill }]} />
        <Bar width="38%" height={10} color={fill} />
      </View>
      {agent(["94%", "88%", "97%", "56%"])}
      <View style={[styles.bubble, { width: "44%", height: 40, backgroundColor: fill }]} />
      {agent(["90%", "72%"])}
    </Animated.View>
  );
}

const styles = StyleSheet.create({
  column: { flex: 1, paddingHorizontal: 18, paddingTop: 26, gap: 24 },
  bubble: { alignSelf: "flex-end", height: 62, borderRadius: 18 },
  trace: { flexDirection: "row", alignItems: "center", gap: 10, marginTop: -6 },
  dot: { width: 14, height: 14, borderRadius: 7 },
});
