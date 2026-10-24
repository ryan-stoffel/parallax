// The desktop's send button, as its Composer and index.css's nightly `.send-sky` draw it: a 36 px
// night sky (a deep indigo fall, a violet glow, four stars, and clouds along its foot) with a
// white arrow, at a quarter strength while there's nothing to send. While a thread works and the
// box is empty, it's Stop instead: a filled square on the danger color.
import { ArrowUp, Square } from "lucide-react-native";
import { Pressable, StyleSheet } from "react-native";
import Svg, { Circle, ClipPath, Defs, G, LinearGradient, Path, RadialGradient, Stop } from "react-native-svg";

import { useColors } from "./ui";

const SIZE = 36;

// The stars, as the CSS's radial gradients: where (in percent), how wide, and how bright.
const stars = [
  [28, 26, 0.8, 1],
  [66, 20, 0.6, 0.8],
  [78, 46, 0.7, 0.7],
  [40, 50, 0.5, 0.6],
] as const;

/** The sky behind the arrow, layered as the CSS's backgrounds and inset shadows are. */
function Sky() {
  const r = SIZE / 2;
  return (
    <Svg width={SIZE} height={SIZE} viewBox={`0 0 ${SIZE} ${SIZE}`} style={StyleSheet.absoluteFill}>
      <Defs>
        <ClipPath id="round">
          <Circle cx={r} cy={r} r={r} />
        </ClipPath>
        <LinearGradient id="fall" x1="0" y1="0" x2="0" y2="1">
          <Stop offset="0" stopColor="#070923" />
          <Stop offset="0.6" stopColor="#17184f" />
          <Stop offset="1" stopColor="#2a2470" />
        </LinearGradient>
        {/* `circle at 70% 10%` reaches its farthest corner at 41 px, and fades out at 60% of that. */}
        <RadialGradient id="glow" gradientUnits="userSpaceOnUse" cx={25.2} cy={3.6} r={24.6}>
          <Stop offset="0" stopColor="#7c3aed" stopOpacity={0.45} />
          <Stop offset="1" stopColor="#7c3aed" stopOpacity={0} />
        </RadialGradient>
        <RadialGradient id="star" cx="0.5" cy="0.5" r="0.5">
          <Stop offset="0.5" stopColor="#ffffff" />
          <Stop offset="1" stopColor="#ffffff" stopOpacity={0} />
        </RadialGradient>
      </Defs>
      <G clipPath="url(#round)">
        <Circle cx={r} cy={r} r={r} fill="url(#fall)" />
        <Circle cx={r} cy={r} r={r} fill="url(#glow)" />
        {stars.map(([x, y, size, opacity]) => (
          <Circle key={`${x}`} cx={(x / 100) * SIZE} cy={(y / 100) * SIZE} r={size} fill="url(#star)" opacity={opacity} />
        ))}
        <G fill="#6e6ac8">
          <Circle cx={8} cy={33} r={6} />
          <Circle cx={17} cy={29} r={7.5} />
          <Circle cx={28} cy={32} r={6.5} />
        </G>
        <G fill="#a5a1ef">
          <Circle cx={12} cy={37} r={5} />
          <Circle cx={22} cy={36} r={6} />
        </G>
        {/* `inset 0 1px 0 rgb(255 255 255 / 25%)`: the sliver between the edge and itself 1 px lower. */}
        <Path
          d={`M0 ${r}a${r} ${r} 0 1 0 ${SIZE} 0a${r} ${r} 0 1 0 -${SIZE} 0ZM0 ${r + 1}a${r} ${r} 0 1 0 ${SIZE} 0a${r} ${r} 0 1 0 -${SIZE} 0Z`}
          fillRule="evenodd"
          fill="rgba(255, 255, 255, 0.25)"
        />
        {/* `inset 0 0 0 1px rgb(165 180 252 / 25%)` */}
        <Circle cx={r} cy={r} r={r - 0.5} fill="none" stroke="rgba(165, 180, 252, 0.25)" strokeWidth={1} />
      </G>
    </Svg>
  );
}

/** The composer's send button, or with `stop`, its Stop. */
export function SendButton({
  stop = false,
  disabled = false,
  label,
  onPress,
}: {
  stop?: boolean;
  disabled?: boolean;
  label: string;
  onPress: () => void;
}) {
  const c = useColors();
  return (
    <Pressable
      accessibilityRole="button"
      accessibilityLabel={label}
      accessibilityState={{ disabled }}
      disabled={disabled}
      onPress={onPress}
      style={({ pressed }) => [
        styles.button,
        stop ? { backgroundColor: c.danger } : styles.sky,
        disabled && { opacity: 0.25 },
        pressed && { opacity: 0.8 },
      ]}
    >
      {stop ? (
        <Square size={14} color={c.background} fill={c.background} />
      ) : (
        <>
          <Sky />
          <ArrowUp size={18} color="#ffffff" />
        </>
      )}
    </Pressable>
  );
}

const styles = StyleSheet.create({
  button: { width: SIZE, height: SIZE, borderRadius: SIZE / 2, alignItems: "center", justifyContent: "center" },
  sky: { boxShadow: "0 4px 14px -4px rgba(79, 70, 229, 0.7)" },
});
