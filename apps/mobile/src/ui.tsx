// The app's small shared pieces: the colors for the system's appearance, the Parallax mark, a
// button, the transcript's text, with code in the desktop's monospace boxes, and swipe-back.
import { useRef, type ReactNode } from "react";
import {
  Animated,
  PanResponder,
  Pressable,
  StyleSheet,
  Text,
  useColorScheme,
  useWindowDimensions,
  View,
  type TextProps,
  type TextStyle,
} from "react-native";

import { dark, font, light, type Colors } from "./theme";

export const useColors = (): Colors => (useColorScheme() === "dark" ? dark : light);

/** The two-circle mark, as the desktop's logos.tsx draws it: coral behind, blue in front. */
export function Mark({ size = 22 }: { size?: number }) {
  const c = useColors();
  const circle = {
    position: "absolute",
    width: size * 0.62,
    height: size * 0.62,
    borderRadius: size,
  } as const;
  return (
    <View style={{ width: size, height: size }}>
      <View style={[circle, { right: 0, bottom: 0, backgroundColor: c.markCoral }]} />
      <View style={[circle, { left: 0, top: 0, backgroundColor: c.markBlue, opacity: 0.92 }]} />
    </View>
  );
}

export function Button({
  label,
  onPress,
  primary,
  disabled,
}: {
  label: string;
  onPress: () => void;
  primary?: boolean;
  disabled?: boolean;
}) {
  const c = useColors();
  return (
    <Pressable
      accessibilityRole="button"
      onPress={onPress}
      disabled={disabled}
      style={({ pressed }) => [
        styles.button,
        primary
          ? { backgroundColor: c.accent, borderColor: c.accent }
          : { borderColor: c.border, backgroundColor: c.surface },
        (pressed || disabled) && { opacity: 0.6 },
      ]}
    >
      <Text style={[styles.buttonText, { color: primary ? "#ffffff" : c.foreground }]}>
        {label}
      </Text>
    </Pressable>
  );
}

/** Text in the app's type and color. */
export function T({
  style,
  muted,
  medium,
  alert,
  ...rest
}: TextProps & { style?: TextStyle; muted?: boolean; medium?: boolean; alert?: boolean }) {
  const c = useColors();
  return (
    <Text
      accessibilityRole={alert ? "alert" : undefined}
      style={[
        {
          fontFamily: medium ? font.medium : font.regular,
          fontSize: 15,
          lineHeight: 22,
          color: muted ? c.mutedForeground : c.foreground,
        },
        style,
      ]}
      {...rest}
    />
  );
}

/**
 * Markdown as the transcript needs it on a phone: fenced code in a box, `inline code`, and
 * **bold**. ponytail: no tables, lists, or link styling; add a renderer when transcripts need
 * them.
 */
export function Markdown({ text }: { text: string }) {
  const c = useColors();
  const blocks = text.split(/```[^\n]*\n?/);
  return (
    <View style={{ gap: 8 }}>
      {blocks.map((block, i) =>
        i % 2 === 1 ? (
          <View key={i} style={[styles.code, { backgroundColor: c.code, borderColor: c.border }]}>
            <Text
              style={{ fontFamily: font.mono, fontSize: 13, lineHeight: 19, color: c.foreground }}
            >
              {block.replace(/\n$/, "")}
            </Text>
          </View>
        ) : block.trim() ? (
          <T key={i}>
            {block
              .trim()
              .split(/(`[^`]+`|\*\*[^*]+\*\*)/)
              .map((part, j) =>
                part.startsWith("`") ? (
                  <Text
                    key={j}
                    style={{ fontFamily: font.mono, fontSize: 13, backgroundColor: c.code }}
                  >
                    {part.slice(1, -1)}
                  </Text>
                ) : part.startsWith("**") ? (
                  <Text key={j} style={{ fontFamily: font.medium }}>
                    {part.slice(2, -2)}
                  </Text>
                ) : (
                  part
                ),
              )}
          </T>
        ) : null,
      )}
    </View>
  );
}

/**
 * A pushed screen that a drag from the left edge takes back, as iOS's own stacks do: past a third
 * of the width, or flicked, it slides away and calls `onBack`.
 */
export function SwipeBack({ onBack, children }: { onBack: () => void; children: ReactNode }) {
  const { width } = useWindowDimensions();
  const x = useRef(new Animated.Value(0)).current;
  const settle = (back: boolean) =>
    Animated.timing(x, { toValue: back ? width : 0, duration: 180, useNativeDriver: true }).start(
      () => back && onBack(),
    );
  const pan = useRef(
    PanResponder.create({
      // Where the touch began: `x0` is still 0 until the responder is granted.
      onMoveShouldSetPanResponderCapture: (_, g) =>
        g.moveX - g.dx < 24 && g.dx > 8 && Math.abs(g.dy) < g.dx,
      onPanResponderMove: (_, g) => x.setValue(Math.max(0, g.dx)),
      onPanResponderRelease: (_, g) => settle(g.dx > width / 3 || g.vx > 0.5),
      // A native view took the gesture over: slide back.
      onPanResponderTerminate: () => settle(false),
    }),
  ).current;
  return (
    <Animated.View style={{ flex: 1, transform: [{ translateX: x }] }} {...pan.panHandlers}>
      {children}
    </Animated.View>
  );
}

const styles = StyleSheet.create({
  button: {
    borderWidth: 1,
    borderRadius: 10,
    paddingHorizontal: 14,
    paddingVertical: 9,
    alignItems: "center",
  },
  buttonText: { fontFamily: font.medium, fontSize: 14 },
  code: { borderWidth: 1, borderRadius: 8, padding: 10 },
});
