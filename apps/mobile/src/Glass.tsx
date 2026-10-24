// Round glass buttons, as iOS 26 draws its own bar buttons: Liquid Glass where the system has it,
// and a translucent circle where it doesn't. The header's sidebar button, the sidebar's search, and
// the Settings sheet's close and info buttons use them.
import { GlassView, isLiquidGlassAvailable } from "expo-glass-effect";
import * as Haptics from "expo-haptics";
import type { ReactNode } from "react";
import { Pressable, StyleSheet, View } from "react-native";
import Svg, { Path } from "react-native-svg";

import { useColors } from "./ui";

const glass = isLiquidGlassAvailable();

/** A round glass button holding an icon, with a light tap. */
export function GlassButton({
  label,
  onPress,
  children,
  size = 44,
  dark,
}: {
  label: string;
  onPress: () => void;
  children: ReactNode;
  size?: number;
  /** Drawn over a dark backdrop, such as the nightly sky, in either appearance. */
  dark?: boolean;
}) {
  const c = useColors();
  const shape = { width: size, height: size, borderRadius: size / 2 };
  return (
    <Pressable
      accessibilityRole="button"
      accessibilityLabel={label}
      hitSlop={6}
      onPress={() => {
        void Haptics.selectionAsync();
        onPress();
      }}
      style={({ pressed }) => [shape, { transform: [{ scale: pressed ? 0.92 : 1 }] }]}
    >
      {glass ? (
        <GlassView isInteractive colorScheme={dark ? "dark" : "auto"} style={[shape, styles.center]}>
          {children}
        </GlassView>
      ) : (
        <View
          style={[
            shape,
            styles.center,
            dark
              ? { backgroundColor: "rgba(255, 255, 255, 0.14)", borderColor: "rgba(255, 255, 255, 0.2)" }
              : { backgroundColor: c.selected, borderColor: c.border },
            { borderWidth: StyleSheet.hairlineWidth },
          ]}
        >
          {children}
        </View>
      )}
    </Pressable>
  );
}

/** Two lines, the lower one shorter: the sidebar's icon, as Claude's app draws it. */
export function SidebarIcon({ size = 20, color }: { size?: number; color: string }) {
  return (
    <Svg width={size} height={size} viewBox="0 0 24 24" fill="none" stroke={color} strokeWidth={2} strokeLinecap="round">
      <Path d="M4 8.5h16M4 15.5h10" />
    </Svg>
  );
}

const styles = StyleSheet.create({
  center: { alignItems: "center", justifyContent: "center", overflow: "hidden" },
});
