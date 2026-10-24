// The app's shared pieces, drawn as the desktop draws them: its colors for the appearance, the
// Parallax mark, lucide icons (the desktop's own set), text in the system's font, its attention
// marks, grouped lists as iOS Settings draws them, and Markdown, with its code, tables, LaTeX,
// and images that open in the lightbox, as the desktop's transcript renders it.
import * as Clipboard from "expo-clipboard";
import type { LucideIcon } from "lucide-react-native";
import {
  Check,
  ChevronRight,
  CircleAlert,
  Copy,
  Eye,
  Laptop,
  MessageCircleQuestion,
  Monitor,
  Server,
} from "lucide-react-native";
import type { Token, Tokens } from "marked";
import { createContext, useContext, useEffect, useMemo, useRef, useState, type ReactNode } from "react";
import {
  Animated,
  Easing,
  Image,
  Linking,
  Pressable,
  ScrollView,
  StyleSheet,
  Text,
  useColorScheme,
  View,
  type ColorValue,
  type TextProps,
  type TextStyle,
  type ViewStyle,
} from "react-native";
import Svg, {
  Circle,
  ClipPath,
  Defs,
  G,
  LinearGradient,
  Mask,
  Path,
  RadialGradient,
  Rect,
  Stop,
} from "react-native-svg";

import type { Attention } from "../../desktop/src/renderer/attention";
import { onGithub } from "../../desktop/src/renderer/github";
import { openLightbox } from "./Lightbox";
import { deviceKind } from "./machines";
import { highlight, lex, linkedPath, type MathToken } from "./markdown";
import { DisplayMath, InlineMath } from "./Math";
import { dark, font, light, type Colors } from "./theme";

export const useColors = (): Colors => (useColorScheme() === "dark" ? dark : light);

/**
 * The mark, as the desktop's logos.tsx draws it on a 24-unit grid: the blue circle, the coral one
 * over it, and their overlap in --mark-overlap, navy on light and near-white on dark.
 */
export function Mark({ size = 22 }: { size?: number }) {
  const c = useColors();
  return (
    <Svg width={size} height={size} viewBox="0 0 24 24">
      <Defs>
        <ClipPath id="blue">
          <Circle cx={9.5} cy={9.5} r={7} />
        </ClipPath>
      </Defs>
      <Circle cx={9.5} cy={9.5} r={7} fill={c.markBlue} />
      <Circle cx={14.5} cy={14.5} r={7} fill={c.markCoral} />
      <Circle cx={14.5} cy={14.5} r={7} fill={c.markOverlap} clipPath="url(#blue)" />
    </Svg>
  );
}

/** The mark and "Parallax" in the brand's Sora, as the desktop's top row shows them. */
export function Wordmark({ size = 17, color }: { size?: number; color?: string }) {
  const c = useColors();
  return (
    <View style={{ flexDirection: "row", alignItems: "center", gap: 6, paddingHorizontal: 4 }}>
      <Mark size={size + 1} />
      <Text style={{ fontFamily: font.brand, fontSize: size, color: color ?? c.foreground }}>Parallax</Text>
    </View>
  );
}

// The nightly sky, as the desktop's NightSky.tsx and index.css draw it: stars from a fixed seed,
// so every launch draws the same sky, and clouds in three layers, back to front.
const skyStars = (() => {
  let seed = 7;
  const next = () => (seed = (seed * 16807) % 2147483647) / 2147483647;
  return Array.from({ length: 34 }, () => [next() * 640, next() * 40, 0.4 + next() * 0.8, 0.4 + next() * 0.6] as const);
})();
const skyClouds: [number, number, number, 0 | 1 | 2][] = [
  [60, 50, 1.1, 0],
  [250, 49, 1.2, 0],
  [470, 50, 1.1, 0],
  [-6, 56, 0.9, 1],
  [150, 55, 0.8, 1],
  [350, 56, 1, 1],
  [560, 55, 0.9, 1],
  [90, 61, 0.9, 2],
  [270, 61, 0.8, 2],
  [450, 62, 0.9, 2],
  [620, 61, 0.8, 2],
];
// The desktop's night, in both appearances: the sky's stops, its stars and glow, and each cloud
// layer's lit top and body, far to near.
const sky = {
  stops: ["#070923", "#17184f", "#2a2470"],
  star: "#ffffff",
  glow: "#7c3aed",
  clouds: [
    ["#3c3a8c", "#2c2a6e"],
    ["#5753b4", "#43409a"],
    ["#8a86e4", "#6e6ac8"],
  ],
};

/** `from` moved toward `to` by `k` (0 to 1), both `#rrggbb`. */
function mix(from: string, to: string, k: number): string {
  const channel = (hex: string, i: number) => parseInt(hex.slice(1 + i * 2, 3 + i * 2), 16);
  return `#${[0, 1, 2]
    .map((i) => Math.round(channel(from, i) + (channel(to, i) - channel(from, i)) * k))
    .map((v) => v.toString(16).padStart(2, "0"))
    .join("")}`;
}

function Cloud({ fill, dy = 0 }: { fill: string; dy?: number }) {
  return (
    <G fill={fill} transform={`translate(0 ${dy})`}>
      <Circle cx={-12} cy={-2} r={7} />
      <Circle cx={0} cy={-7} r={10} />
      <Circle cx={14} cy={-9} r={12} />
      <Circle cx={28} cy={-4} r={8} />
      <Rect x={-20} y={-5} width={56} height={12} rx={6} />
    </G>
  );
}

/**
 * The nightly build's sky across the top of a screen, as the desktop's sidebar wears it: night
 * down to `solid` points, with stars, a glow, and clouds along the bottom of the bar at `bar`,
 * then a `fade` into the page. Put it behind a screen's content.
 */
export function SkyBanner({ bar, solid, fade }: { bar: number; solid: number; fade: number }) {
  const c = useColors();
  const height = solid + fade;
  const at = (y: number) => y / height;
  // Night down to `solid`, then an eased fade into the page, so the sky has no edge.
  const eased = [0, 0.12, 0.3, 0.5, 0.7, 0.86, 1].map((t) => ({
    offset: at(solid + fade * t),
    color: mix(sky.stops[2]!, c.background, 1 - (1 - t) ** 2.2),
  }));
  // The art is 640 by 56: drawn at the bar's bottom, as tall as 56 points, and cropped at the sides.
  const art = 56;
  return (
    <View pointerEvents="none" style={[StyleSheet.absoluteFill, { height }]}>
      <Svg width="100%" height={height}>
        <Defs>
          <LinearGradient id="sky" x1="0" y1="0" x2="0" y2={height} gradientUnits="userSpaceOnUse">
            {[
              { offset: 0, color: sky.stops[0]! },
              { offset: at(bar * 0.6), color: sky.stops[1]! },
              ...eased,
            ].map((e, i) => (
              <Stop key={i} offset={e.offset} stopColor={e.color} />
            ))}
          </LinearGradient>
          <RadialGradient id="glow" cx="0.75" cy="0" r="0.6">
            <Stop offset="0" stopColor={sky.glow} stopOpacity={0.4} />
            <Stop offset="1" stopColor={sky.glow} stopOpacity={0} />
          </RadialGradient>
        </Defs>
        <Rect width="100%" height={height} fill="url(#sky)" />
        <Rect width="100%" height={solid} fill="url(#glow)" />
      </Svg>
      <Svg
        width="100%"
        height={art}
        viewBox="0 0 640 56"
        preserveAspectRatio="xMidYMax slice"
        style={{ position: "absolute", top: bar - art + 6, left: 0, right: 0 }}
      >
        <Defs>
          <LinearGradient id="thin" x1="0" y1="36" x2="0" y2="52" gradientUnits="userSpaceOnUse">
            <Stop offset="0" stopColor="#ffffff" />
            <Stop offset="1" stopColor="#ffffff" stopOpacity={0} />
          </LinearGradient>
          <Mask id="clouds" maskUnits="userSpaceOnUse" x="0" y="0" width="640" height="56">
            <Rect width={640} height={56} fill="url(#thin)" />
          </Mask>
        </Defs>
        {skyStars.map(([x, y, r, o], i) => (
          <Circle key={i} cx={x} cy={y} r={r} fill={sky.star} opacity={o} />
        ))}
        <G mask="url(#clouds)">
          {([0, 1, 2] as const).map((layer) =>
            skyClouds
              .filter((cl) => cl[3] === layer)
              .map(([x, y, scale]) => (
                <G key={`${layer}${x}`} transform={`translate(${x} ${y}) scale(${scale})`}>
                  <Cloud fill={sky.clouds[layer]![0]!} />
                  <Cloud fill={sky.clouds[layer]![1]!} dy={2.5} />
                </G>
              )),
          )}
        </G>
      </Svg>
    </View>
  );
}

/** A round button's night sky, as the desktop's nightly send button wears it: a disc of `size`. */
export function NightOrb({ size }: { size: number }) {
  const r = size / 2;
  return (
    <Svg width={size} height={size} style={StyleSheet.absoluteFill}>
      <Defs>
        <LinearGradient id="orb" x1="0" y1="0" x2="0" y2="1">
          <Stop offset="0" stopColor="#070923" />
          <Stop offset="0.6" stopColor="#17184f" />
          <Stop offset="1" stopColor="#2a2470" />
        </LinearGradient>
        <RadialGradient id="orbglow" cx="0.7" cy="0.15" r="0.6">
          <Stop offset="0" stopColor="#7c3aed" stopOpacity={0.5} />
          <Stop offset="1" stopColor="#7c3aed" stopOpacity={0} />
        </RadialGradient>
      </Defs>
      <Circle cx={r} cy={r} r={r} fill="url(#orb)" />
      <Circle cx={r} cy={r} r={r} fill="url(#orbglow)" />
      {[
        [0.3, 0.28, 0.7, 1],
        [0.66, 0.22, 0.6, 0.8],
        [0.74, 0.5, 0.6, 0.7],
        [0.24, 0.64, 0.5, 0.55],
        [0.6, 0.76, 0.5, 0.6],
      ].map(([x, y, rr, o], i) => (
        <Circle key={i} cx={x! * size} cy={y! * size} r={rr} fill="#ffffff" opacity={o} />
      ))}
    </Svg>
  );
}

/** A lucide icon, as the desktop draws its: 2 px strokes, in the text's color. */
export function Icon({
  icon: Glyph,
  size = 16,
  color,
  strokeWidth = 2,
}: {
  icon: LucideIcon;
  size?: number;
  color?: ColorValue;
  strokeWidth?: number;
}) {
  const c = useColors();
  return <Glyph size={size} color={(color ?? c.foreground) as string} strokeWidth={strokeWidth} />;
}

/** A mini PC, such as a Mac mini, as the desktop draws it: a low box with a light. */
function MiniPc({ size = 24, color, strokeWidth = 2 }: { size?: number; color?: string; strokeWidth?: number }) {
  return (
    <Svg width={size} height={size} viewBox="0 0 24 24" fill="none" stroke={color} strokeWidth={strokeWidth} strokeLinecap="round" strokeLinejoin="round">
      <Rect x={2} y={7} width={20} height={10} rx={3} />
      <Path d="M6 13h.01" />
    </Svg>
  );
}

const deviceIcons = { laptop: Laptop, desktop: Monitor, mini: MiniPc, server: Server };

/** GitHub's mark, as the desktop's logos.tsx draws it. */
export function GitHubLogo({ size = 18, color }: { size?: number; color?: ColorValue }) {
  const c = useColors();
  return (
    <Svg width={size} height={size} viewBox="0 0 24 24">
      <Path
        fill={(color ?? c.foreground) as string}
        fillRule="evenodd"
        d="M12 0c6.63 0 12 5.276 12 11.79-.001 5.067-3.29 9.567-8.175 11.187-.6.118-.825-.25-.825-.56 0-.398.015-1.665.015-3.242 0-1.105-.375-1.813-.81-2.181 2.67-.295 5.475-1.297 5.475-5.822 0-1.297-.465-2.344-1.23-3.169.12-.295.54-1.503-.12-3.125 0 0-1.005-.324-3.3 1.209a11.32 11.32 0 00-3-.398c-1.02 0-2.04.133-3 .398-2.295-1.518-3.3-1.209-3.3-1.209-.66 1.622-.24 2.83-.12 3.125-.765.825-1.23 1.887-1.23 3.169 0 4.51 2.79 5.527 5.46 5.822-.345.294-.66.81-.765 1.577-.69.31-2.415.81-3.495-.973-.225-.354-.9-1.223-1.845-1.209-1.005.015-.405.56.015.781.51.28 1.095 1.327 1.23 1.666.24.663 1.02 1.93 4.035 1.385 0 .988.015 1.916.015 2.196 0 .31-.225.664-.825.56C3.303 21.374-.003 16.867 0 11.791 0 5.276 5.37 0 12 0z"
      />
    </Svg>
  );
}

/** A computer's icon, by its name, as the desktop's DeviceIcon draws it. */
export function DeviceIcon({ name, size = 16, color }: { name: string; size?: number; color?: ColorValue }) {
  const c = useColors();
  const Glyph = deviceIcons[deviceKind(name)];
  return <Glyph size={size} color={(color ?? c.foreground) as string} strokeWidth={2} />;
}

export function Button({
  label,
  onPress,
  primary,
  destructive,
  disabled,
  icon,
  style,
}: {
  label: string;
  onPress: () => void;
  primary?: boolean;
  destructive?: boolean;
  disabled?: boolean;
  icon?: LucideIcon;
  style?: ViewStyle;
}) {
  const c = useColors();
  const color = primary ? "#ffffff" : destructive ? c.danger : c.foreground;
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
        (pressed || disabled) && { opacity: 0.55 },
        style,
      ]}
    >
      {icon && <Icon icon={icon} size={16} color={color} />}
      <Text style={[styles.buttonText, { color }]}>{label}</Text>
    </Pressable>
  );
}

/** Text in the desktop's type, the system's font, and color. */
export function T({
  style,
  muted,
  faint,
  medium,
  mono,
  alert,
  ...rest
}: TextProps & {
  style?: TextStyle;
  muted?: boolean;
  faint?: boolean;
  medium?: boolean;
  mono?: boolean;
  alert?: boolean;
}) {
  const c = useColors();
  return (
    <Text
      accessibilityRole={alert ? "alert" : undefined}
      style={[
        {
          fontSize: 15,
          lineHeight: 21,
          color: faint ? c.faintForeground : muted ? c.mutedForeground : c.foreground,
        },
        medium && { fontWeight: "500" },
        mono && { fontFamily: font.mono, fontSize: 13 },
        style,
      ]}
      {...rest}
    />
  );
}

/** A small round dot. */
export function Dot({ color, size = 8 }: { color: ColorValue; size?: number }) {
  return <View style={{ width: size, height: size, borderRadius: size, backgroundColor: color }} />;
}

// The working mark's ring: eight dots from the top, the first solid and each counterclockwise of
// it fainter, so as the ring turns clockwise they trail it (AttentionMark.tsx).
const ring = Array.from({ length: 8 }, (_, i) => {
  const angle = (i / 8) * 2 * Math.PI;
  return { x: 12 - 8 * Math.sin(angle), y: 12 - 8 * Math.cos(angle), opacity: 1 - i * 0.11 };
});

/** A ring of dots in Parallax blue, turning while an agent works, as the desktop's. */
export function WorkingMark({ size = 14 }: { size?: number }) {
  const c = useColors();
  const turn = useRef(new Animated.Value(0)).current;
  useEffect(() => {
    const loop = Animated.loop(
      Animated.timing(turn, {
        toValue: 1,
        duration: 1200,
        easing: Easing.linear,
        useNativeDriver: true,
      }),
    );
    loop.start();
    return () => loop.stop();
  }, [turn]);
  const rotate = turn.interpolate({ inputRange: [0, 1], outputRange: ["0deg", "360deg"] });
  return (
    <Animated.View style={{ width: size, height: size, transform: [{ rotate }] }}>
      <Svg width={size} height={size} viewBox="0 0 24 24">
        {ring.map((dot, i) => (
          <Circle key={i} cx={dot.x} cy={dot.y} r={2} fill={c.markBlue} opacity={dot.opacity} />
        ))}
      </Svg>
    </Animated.View>
  );
}

/** A check in a green disc, the desktop's Done. */
export function DoneMark({ size = 14 }: { size?: number }) {
  const c = useColors();
  return (
    <Svg width={size} height={size} viewBox="0 0 24 24">
      <Circle cx={12} cy={12} r={9} fill={c.added} />
      <Path
        d="m8 12.4 2.7 2.6L16 9.6"
        fill="none"
        stroke={c.background}
        strokeWidth={2.6}
        strokeLinecap="round"
        strokeLinejoin="round"
      />
    </Svg>
  );
}

/** "12s", "4m 05s", "1h 02m": how long a turn has gone, as the desktop says it. */
export function duration(seconds: number): string {
  if (seconds < 60) return `${seconds}s`;
  const m = Math.floor(seconds / 60);
  if (m < 60) return `${m}m ${String(seconds % 60).padStart(2, "0")}s`;
  return `${Math.floor(m / 60)}h ${String(m % 60).padStart(2, "0")}m`;
}

/** Whole seconds since `from`, ticking every second. */
export function useSeconds(from?: string) {
  const [now, setNow] = useState(Date.now);
  useEffect(() => {
    const timer = setInterval(() => setNow(Date.now()), 1000);
    return () => clearInterval(timer);
  }, []);
  return from ? Math.max(0, Math.floor((now - Date.parse(from)) / 1000)) : 0;
}

function WorkingFor({ since }: { since: string }) {
  return <>Working {duration(useSeconds(since))}</>;
}

/**
 * A thread's status as the desktop's sidebar shows it (AttentionBadge): its mark and a word,
 * Working for how long, Needs you, Done, or Failed. Settled shows nothing.
 */
export function AttentionBadge({ attention, since }: { attention: Attention; since?: string }) {
  const c = useColors();
  const look = (color: string, mark: ReactNode, word: ReactNode) => (
    <View style={styles.badge}>
      {mark}
      <Text style={[styles.badgeText, { color }]}>{word}</Text>
    </View>
  );
  switch (attention) {
    case "working":
      return look(c.accent, <WorkingMark />, since ? <WorkingFor since={since} /> : "Working");
    case "monitoring":
    case "waiting":
      return look(
        c.accent,
        <Icon icon={Eye} size={14} color={c.accent} />,
        attention === "monitoring" ? "Monitoring" : "Waiting",
      );
    case "needsYou":
      return look(
        c.warning,
        <Icon icon={MessageCircleQuestion} size={14} color={c.warning} />,
        "Needs you",
      );
    case "done":
      return look(c.added, <DoneMark />, "Done");
    case "failed":
      return look(
        c.danger,
        <Icon icon={CircleAlert} size={14} color={c.danger} />,
        "Failed",
      );
    default:
      return null;
  }
}

/** A titled group of rows, as iOS Settings draws one. */
export function Section({
  title,
  footer,
  children,
}: {
  title?: string;
  footer?: string;
  children: ReactNode;
}) {
  const c = useColors();
  return (
    <View style={{ gap: 6 }}>
      {title && (
        <T muted style={styles.sectionTitle}>
          {title.toUpperCase()}
        </T>
      )}
      <View style={[styles.group, { backgroundColor: c.surface, borderColor: c.border }]}>
        {children}
      </View>
      {footer && (
        <T faint style={styles.footer}>
          {footer}
        </T>
      )}
    </View>
  );
}

/** One row of a `Section`: an icon, a title and detail, and what's on its right. */
export function Row({
  icon,
  leading,
  iconColor,
  title,
  detail,
  right,
  onPress,
  chevron,
  destructive,
  last,
}: {
  icon?: LucideIcon;
  /** Drawn where the icon goes, in place of one. */
  leading?: ReactNode;
  iconColor?: ColorValue;
  title: string;
  detail?: string;
  right?: ReactNode;
  onPress?: () => void;
  chevron?: boolean;
  destructive?: boolean;
  last?: boolean;
}) {
  const c = useColors();
  return (
    <Pressable
      accessibilityRole={onPress ? "button" : undefined}
      onPress={onPress}
      disabled={!onPress}
      style={({ pressed }) => [styles.row, pressed && { backgroundColor: c.selected }]}
    >
      {leading}
      {icon && (
        <Icon icon={icon} size={18} color={iconColor ?? (destructive ? c.danger : c.mutedForeground)} />
      )}
      <View
        style={[
          styles.rowBody,
          !last && { borderBottomColor: c.border, borderBottomWidth: StyleSheet.hairlineWidth },
        ]}
      >
        <View style={{ flex: 1, gap: 1 }}>
          <T style={destructive ? { color: c.danger } : undefined}>{title}</T>
          {!!detail && (
            <T muted style={{ fontSize: 13, lineHeight: 18 }}>
              {detail}
            </T>
          )}
        </View>
        {right}
        {chevron && <Icon icon={ChevronRight} size={16} color={c.faintForeground} />}
      </View>
    </Pressable>
  );
}

/** Which remote images Markdown shows: a pull request's GitHub-hosted ones, or none. */
type Images = "github" | "none";

/**
 * What a Markdown tree's pieces share: which images show, every picture shown for the lightbox,
 * what opens a linked file, and whether they're in a quote, or how deep in lists.
 */
interface MarkdownScope {
  images: Images;
  all: () => string[];
  onFile?: (path: string) => void;
  quoted: boolean;
  depth: number;
}
const MarkdownContext = createContext<MarkdownScope>({ images: "none", all: () => [], quoted: false, depth: 0 });

// Code's syntax colors, the desktop's --syntax-* for each appearance.
const syntax = {
  light: { keyword: "#2b5cff", string: "#c2410c", number: "#7c3aed", title: "#4338ca", type: "#be185d", comment: "#6e6c88" },
  dark: { keyword: "#7b9bff", string: "#ff8a65", number: "#c4b5fd", title: "#a5b4fc", type: "#f9a8d4", comment: "#7d7c93" },
};

/** Follows a Markdown link: a file to `onFile`, a web page or email to the system, anything else nowhere. */
function follow(href: string, onFile?: (path: string) => void) {
  const path = linkedPath(href);
  if (path !== undefined) onFile?.(path);
  else if (/^(https?|mailto):/i.test(href)) void Linking.openURL(href);
}

/** A Markdown image: its picture, full width at its own shape, opening the lightbox. */
function MarkdownImage({ src, alt, all }: { src: string; alt: string; all: () => string[] }) {
  const c = useColors();
  const [ratio, setRatio] = useState<number>();
  useEffect(() => {
    Image.getSize(src, (w, h) => setRatio(w / h), () => setRatio(0));
  }, [src]);
  if (ratio === 0)
    return (
      <Text style={{ color: c.accent }} onPress={() => void Linking.openURL(src)}>
        {alt || "Image"}
      </Text>
    );
  return (
    <Pressable
      accessibilityRole="imagebutton"
      accessibilityLabel={alt || "Image"}
      onPress={() => {
        const list = all();
        openLightbox(
          list.map((uri) => ({ uri })),
          Math.max(0, list.indexOf(src)),
        );
      }}
    >
      <Image
        source={{ uri: src }}
        accessibilityIgnoresInvertColors
        style={{
          width: "100%",
          aspectRatio: ratio ?? 16 / 9,
          borderRadius: 8,
          backgroundColor: c.code,
        }}
        resizeMode="contain"
      />
    </Pressable>
  );
}

/**
 * Inline Markdown inside a `Text` of font `size`: bold, italics, struck text, code, links, math,
 * and an image left inline as a link with its alt text, as the desktop's transcript shows one.
 */
function Inline({ tokens, size = 15 }: { tokens?: Token[]; size?: number }): ReactNode {
  const c = useColors();
  const { onFile, quoted } = useContext(MarkdownContext);
  return tokens?.map((t, i) => {
    switch (t.type) {
      case "strong":
        return (
          <Text key={i} style={{ fontWeight: "600" }}>
            <Inline tokens={t.tokens} size={size} />
          </Text>
        );
      case "em":
        return (
          <Text key={i} style={{ fontStyle: "italic" }}>
            <Inline tokens={t.tokens} size={size} />
          </Text>
        );
      case "del":
        return (
          <Text key={i} style={{ textDecorationLine: "line-through" }}>
            <Inline tokens={t.tokens} size={size} />
          </Text>
        );
      case "codespan":
        return (
          <Text key={i} style={{ fontFamily: font.mono, fontSize: size * 0.86, backgroundColor: c.code }}>
            {unescape((t as Tokens.Codespan).text)}
          </Text>
        );
      case "link":
        return (
          <Text key={i} style={{ color: c.accent }} onPress={() => follow((t as Tokens.Link).href, onFile)}>
            <Inline tokens={t.tokens} size={size} />
          </Text>
        );
      case "image": {
        const image = t as Tokens.Image;
        return (
          <Text key={i} style={{ color: c.accent }} onPress={() => follow(image.href, onFile)}>
            {image.text || "Image"}
          </Text>
        );
      }
      case "math": {
        const math = t as MathToken;
        return (
          <InlineMath
            key={i}
            tex={math.text}
            raw={math.raw}
            size={size}
            color={quoted ? c.mutedForeground : c.foreground}
          />
        );
      }
      case "br":
        return "\n";
      // A task's box, which the list draws itself.
      case "checkbox":
        return null;
      case "text":
        return "tokens" in t && t.tokens ? (
          <Inline key={i} tokens={t.tokens} size={size} />
        ) : (
          unescape((t as Tokens.Text).text)
        );
      default:
        return unescape("text" in t ? String(t.text) : t.raw);
    }
  });
}

const entities: Record<string, string> = { amp: "&", lt: "<", gt: ">", quot: '"', "#39": "'" };
const unescape = (text: string) => text.replace(/&(amp|lt|gt|quot|#39);/g, (_, e) => entities[e]!);

/** The images a paragraph's tokens hold, at any depth (a linked image too). */
const imagesIn = (tokens: Token[] = []): Tokens.Image[] =>
  tokens.flatMap((t) =>
    t.type === "image" ? [t as Tokens.Image] : "tokens" in t ? imagesIn(t.tokens) : [],
  );

/** A text token with the space at its start or end trimmed, where a line of text meets a block. */
const trimmed = (t: Token | undefined, end: "start" | "end"): Token | undefined =>
  t?.type === "text" && !("tokens" in t && t.tokens)
    ? { ...t, text: end === "start" ? t.text.trimStart() : t.text.trimEnd() }
    : t;

/**
 * A paragraph's text, with its display math and shown pictures as blocks in their places, so math
 * centers on a line of its own, as the desktop's displayDoubleDollar sets `$$...$$` in a line.
 */
function Paragraph({ tokens = [] }: { tokens?: Token[] }) {
  const { images, all, quoted } = useContext(MarkdownContext);
  const c = useColors();
  const pictures = images === "github" ? imagesIn(tokens).filter((t) => onGithub(t.href)) : [];
  const parts: (Token | Token[])[] = [];
  for (const t of tokens) {
    const last = parts.at(-1);
    if ((t.type === "math" && (t as MathToken).display) || pictures.includes(t as Tokens.Image)) parts.push(t);
    else if (Array.isArray(last)) last.push(t);
    else parts.push([t]);
  }
  // A picture inside a link stays its link in the text, and shows after it too.
  const nested = pictures.filter((p) => !tokens.includes(p));
  return (
    <View style={{ gap: 8 }}>
      {parts.map((part, i) => {
        if (!Array.isArray(part)) {
          if (part.type === "image") {
            const p = part as Tokens.Image;
            return <MarkdownImage key={i} src={p.href} alt={p.text} all={all} />;
          }
          const math = part as MathToken;
          return <DisplayMath key={i} tex={math.text} raw={math.raw} size={15} color={quoted ? c.mutedForeground : c.foreground} />;
        }
        if (!part.some((t) => t.raw.trim())) return null;
        const words = [trimmed(part[0], "start"), ...part.slice(1)];
        words.push(trimmed(words.pop(), "end"));
        return (
          <T key={i} selectable muted={quoted} style={{ lineHeight: 22 }}>
            <Inline tokens={words.filter((t) => t !== undefined)} />
          </T>
        );
      })}
      {nested.map((p, i) => (
        <MarkdownImage key={`n${i}`} src={p.href} alt={p.text} all={all} />
      ))}
    </View>
  );
}

/**
 * A code block, as the desktop's CodeBlock: a header with its fence's language and Copy, over its
 * code in JetBrains Mono, scrolling sideways, in simple syntax colors, or a diff's lines in green
 * and red.
 */
function CodeBlock({ code }: { code: Tokens.Code }) {
  const c = useColors();
  const colors = useColorScheme() === "dark" ? syntax.dark : syntax.light;
  const [copied, setCopied] = useState(false);
  const language = code.lang?.split(/\s/)[0] || undefined;
  const copy = () =>
    void Clipboard.setStringAsync(code.text).then(() => {
      setCopied(true);
      setTimeout(() => setCopied(false), 1500);
    });
  const lines =
    language === "diff" || language === "patch"
      ? code.text.split("\n").map((line, i) => (
          <Text
            key={i}
            style={{
              color: /^\+(?!\+\+)/.test(line)
                ? c.added
                : /^-(?!--)/.test(line)
                  ? c.danger
                  : line.startsWith("@@")
                    ? c.accent
                    : undefined,
            }}
          >
            {i ? "\n" : ""}
            {line}
          </Text>
        ))
      : highlight(code.text, language).map((p, i) => (
          <Text key={i} style={p.kind && { color: colors[p.kind] }}>
            {p.text}
          </Text>
        ));
  return (
    <View style={[styles.code, { backgroundColor: c.code, borderColor: c.border }]}>
      <View style={[styles.codeHeader, { borderBottomColor: c.border }]}>
        <Text style={{ fontFamily: font.mono, fontSize: 11.5, color: c.faintForeground }}>{language ?? "text"}</Text>
        <Pressable
          accessibilityRole="button"
          accessibilityLabel={copied ? "Copied" : "Copy code"}
          onPress={copy}
          hitSlop={8}
          style={({ pressed }) => [styles.copy, pressed && { backgroundColor: c.selected }]}
        >
          <Icon icon={copied ? Check : Copy} size={13} color={c.faintForeground} />
          <Text style={{ fontSize: 12, color: c.faintForeground }}>{copied ? "Copied" : "Copy"}</Text>
        </Pressable>
      </View>
      <ScrollView
        horizontal
        showsHorizontalScrollIndicator={false}
        contentContainerStyle={{ paddingHorizontal: 12, paddingVertical: 10 }}
      >
        <Text selectable style={{ fontFamily: font.mono, fontSize: 12.5, lineHeight: 20, color: c.foreground }}>
          {lines}
        </Text>
      </ScrollView>
    </View>
  );
}

/** A task list's box, checked in the accent color as the desktop's checkbox draws it. */
function TaskBox({ checked }: { checked: boolean }) {
  const c = useColors();
  return (
    <View
      accessible
      accessibilityRole="checkbox"
      accessibilityState={{ checked }}
      style={[
        styles.task,
        checked ? { backgroundColor: c.accent, borderColor: c.accent } : { borderColor: c.faintForeground },
      ]}
    >
      {checked && <Icon icon={Check} size={12} strokeWidth={3} color="#ffffff" />}
    </View>
  );
}

// A list's bullets by how deep it's nested.
const bullets = ["•", "◦", "▪"];

/** A list: numbered, bulleted by depth, or GitHub's task list with its boxes. Items hold any blocks. */
function List({ list }: { list: Tokens.List }) {
  const c = useColors();
  const scope = useContext(MarkdownContext);
  const start = typeof list.start === "number" ? list.start : 1;
  // Room for the widest number, so the items' text lines up.
  const marker = list.ordered ? String(start + list.items.length - 1).length * 9 + 8 : 12;
  return (
    <MarkdownContext value={{ ...scope, depth: scope.depth + 1 }}>
      <View style={{ gap: 4 }}>
        {list.items.map((item, i) => (
          <View key={i} style={{ flexDirection: "row", gap: 8 }}>
            {item.task ? (
              <TaskBox checked={!!item.checked} />
            ) : (
              <T
                style={{
                  minWidth: marker,
                  lineHeight: 22,
                  textAlign: list.ordered ? "right" : "center",
                  color: c.faintForeground,
                  fontVariant: ["tabular-nums"],
                }}
              >
                {list.ordered ? `${start + i}.` : bullets[scope.depth % bullets.length]}
              </T>
            )}
            <View style={{ flex: 1 }}>
              <Blocks tokens={item.tokens} />
            </View>
          </View>
        ))}
      </View>
    </MarkdownContext>
  );
}

/**
 * A table, as the desktop's: in a rounded box that scrolls sideways, its header on a fill. Each
 * column is as wide as its widest cell, up to a wrapping width, measured once before it shows.
 */
function Table({ table }: { table: Tokens.Table }) {
  const c = useColors();
  const rows = [table.header, ...table.rows];
  const [widths, setWidths] = useState<number[]>();
  const measured = useRef<number[]>([]);
  const count = useRef(0);
  const measure = (j: number, width: number) => {
    measured.current[j] = Math.max(measured.current[j] ?? 0, Math.ceil(width));
    if (++count.current === rows.length * table.header.length) setWidths([...measured.current]);
  };
  return (
    <ScrollView horizontal showsHorizontalScrollIndicator={false}>
      <View style={[styles.table, { borderColor: c.border, opacity: widths ? 1 : 0 }]}>
        {rows.map((row, i) => (
          <View
            key={i}
            style={[
              { flexDirection: "row" },
              i === 0 && { backgroundColor: c.hover },
              i < rows.length - 1 && { borderBottomWidth: StyleSheet.hairlineWidth, borderColor: c.border },
            ]}
          >
            {row.map((cell, j) => (
              <View
                key={j}
                onLayout={widths ? undefined : (e) => measure(j, e.nativeEvent.layout.width)}
                style={[
                  styles.cell,
                  widths ? { width: widths[j] } : { maxWidth: 260 },
                  j > 0 && { borderLeftWidth: StyleSheet.hairlineWidth, borderColor: c.border },
                ]}
              >
                <T
                  selectable
                  style={{
                    fontSize: 13,
                    lineHeight: 19,
                    fontWeight: i === 0 ? "600" : "400",
                    textAlign: table.align[j] ?? "left",
                  }}
                >
                  <Inline tokens={cell.tokens} size={13} />
                </T>
              </View>
            ))}
          </View>
        ))}
      </View>
    </ScrollView>
  );
}

function Block({ token, first }: { token: Token; first: boolean }): ReactNode {
  const c = useColors();
  const scope = useContext(MarkdownContext);
  switch (token.type) {
    case "space":
    case "def":
    // A task's box, which the list draws itself.
    case "checkbox":
      return null;
    case "hr":
      return <View style={{ height: StyleSheet.hairlineWidth, backgroundColor: c.border, marginVertical: 8 }} />;
    case "heading": {
      const size = [0, 20, 17, 15, 15, 15, 15][(token as Tokens.Heading).depth]!;
      return (
        <T
          selectable
          muted={scope.quoted}
          style={{ fontSize: size, lineHeight: size * 1.3, fontWeight: "600", letterSpacing: -0.2, marginTop: first ? 0 : 8 }}
        >
          <Inline tokens={token.tokens} size={size} />
        </T>
      );
    }
    case "code":
      return <CodeBlock code={token as Tokens.Code} />;
    case "math": {
      const math = token as unknown as MathToken;
      return <DisplayMath tex={math.text} raw={math.raw} size={15} color={scope.quoted ? c.mutedForeground : c.foreground} />;
    }
    case "blockquote":
      return (
        <View style={{ flexDirection: "row", gap: 11 }}>
          <View style={{ width: 3, borderRadius: 1.5, backgroundColor: c.foreground, opacity: 0.18 }} />
          <View style={{ flex: 1 }}>
            <MarkdownContext value={{ ...scope, quoted: true }}>
              <Blocks tokens={(token as Tokens.Blockquote).tokens} />
            </MarkdownContext>
          </View>
        </View>
      );
    case "list":
      return <List list={token as Tokens.List} />;
    case "table":
      // Measured again when it changes, as a streaming table grows.
      return <Table key={token.raw} table={token as Tokens.Table} />;
    case "paragraph":
    case "text":
      return <Paragraph tokens={"tokens" in token ? token.tokens : undefined} />;
    default:
      // Raw HTML, which agent output never renders, shows as its text.
      return token.raw.trim() ? <T selectable>{token.raw.trim()}</T> : null;
  }
}

function Blocks({ tokens }: { tokens: Token[] }) {
  return (
    <View style={{ gap: 10 }}>
      {tokens.map((t, i) => (
        <Block key={i} token={t} first={i === 0} />
      ))}
    </View>
  );
}

/**
 * Markdown, as GitHub writes it and the desktop's transcript renders it: headings, lists and task
 * lists, tables, quotes, code, links, and LaTeX. With `images` "github", GitHub-hosted images show
 * and open in the lightbox, as the desktop's PR panel shows them; an agent's remote images stay
 * links, as in the desktop's transcript. A link to a file goes to `onFile`, with its path.
 */
export function Markdown({
  text,
  images = "none",
  onFile,
}: {
  text: string;
  images?: Images;
  onFile?: (path: string) => void;
}) {
  const tokens = useMemo(() => lex(text), [text]);
  const all = () =>
    images === "github"
      ? imagesIn(tokens.flatMap((t) => ("tokens" in t ? (t.tokens ?? []) : [t])))
          .map((t) => t.href)
          .filter(onGithub)
      : [];
  return (
    <MarkdownContext value={{ images, all, onFile, quoted: false, depth: 0 }}>
      <Blocks tokens={tokens} />
    </MarkdownContext>
  );
}

const styles = StyleSheet.create({
  button: {
    flexDirection: "row",
    gap: 6,
    borderWidth: 1,
    borderRadius: 12,
    paddingHorizontal: 16,
    paddingVertical: 11,
    alignItems: "center",
    justifyContent: "center",
  },
  buttonText: { fontSize: 15, fontWeight: "500" },
  badge: { flexDirection: "row", alignItems: "center", gap: 4 },
  badgeText: { fontSize: 12, fontWeight: "500", fontVariant: ["tabular-nums"] },
  code: { borderWidth: StyleSheet.hairlineWidth, borderRadius: 12, overflow: "hidden" },
  codeHeader: {
    flexDirection: "row",
    alignItems: "center",
    justifyContent: "space-between",
    height: 32,
    paddingLeft: 12,
    paddingRight: 4,
    borderBottomWidth: StyleSheet.hairlineWidth,
  },
  copy: { flexDirection: "row", alignItems: "center", gap: 4, height: 24, paddingHorizontal: 6, borderRadius: 6 },
  task: {
    width: 16,
    height: 16,
    marginTop: 3,
    borderRadius: 4,
    borderWidth: 1.5,
    alignItems: "center",
    justifyContent: "center",
  },
  table: { borderWidth: StyleSheet.hairlineWidth, borderRadius: 8, overflow: "hidden" },
  cell: { paddingHorizontal: 11, paddingVertical: 6 },
  sectionTitle: { fontSize: 12, letterSpacing: 0.4, paddingHorizontal: 16 },
  footer: { fontSize: 12, lineHeight: 17, paddingHorizontal: 16 },
  group: { borderRadius: 14, borderWidth: StyleSheet.hairlineWidth, overflow: "hidden" },
  row: { flexDirection: "row", alignItems: "center", gap: 12, paddingLeft: 16 },
  rowBody: {
    flex: 1,
    flexDirection: "row",
    alignItems: "center",
    gap: 8,
    paddingVertical: 11,
    paddingRight: 14,
  },
});
