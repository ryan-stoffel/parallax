// Glass, as iOS 26 draws its own bar buttons and search fields: Liquid Glass where the system has
// it, and a translucent fill where it doesn't. The header's sidebar button, the sidebar's search,
// the sheets' close, back, info, and refresh buttons, and Search's field use it.
import { GlassView, isLiquidGlassAvailable } from "expo-glass-effect";
import * as Haptics from "expo-haptics";
import type { ReactNode } from "react";
import { Pressable, StyleSheet, View, type StyleProp, type ViewStyle } from "react-native";
import Svg, { Path, Rect } from "react-native-svg";

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
      <Glass interactive dark={dark} style={[shape, styles.center]}>
        {children}
      </Glass>
    </Pressable>
  );
}

/** A glass surface of any shape, such as a search field's capsule. */
export function Glass({
  style,
  children,
  interactive,
  dark,
}: {
  style?: StyleProp<ViewStyle>;
  children: ReactNode;
  interactive?: boolean;
  dark?: boolean;
}) {
  const c = useColors();
  if (glass)
    return (
      <GlassView isInteractive={interactive} colorScheme={dark ? "dark" : "auto"} style={style}>
        {children}
      </GlassView>
    );
  return (
    <View
      style={[
        dark
          ? { backgroundColor: "rgba(255, 255, 255, 0.14)", borderColor: "rgba(255, 255, 255, 0.2)" }
          : { backgroundColor: c.selected, borderColor: c.border },
        { borderWidth: StyleSheet.hairlineWidth },
        style,
      ]}
    >
      {children}
    </View>
  );
}

/** A window with its sidebar on the left, as iOS's own sidebar button draws it. */
export function SidebarIcon({ size = 22, color }: { size?: number; color: string }) {
  return (
    <Svg width={size} height={size} viewBox="0 0 24 24" fill="none" stroke={color} strokeWidth={1.8} strokeLinecap="round">
      <Rect x={2.75} y={4.25} width={18.5} height={15.5} rx={4} />
      <Path d="M9.25 4.5v15M5.5 8.5h1.25M5.5 11.5h1.25" />
    </Svg>
  );
}

const styles = StyleSheet.create({
  center: { alignItems: "center", justifyContent: "center", overflow: "hidden" },
});
