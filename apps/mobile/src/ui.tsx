// The app's shared pieces, drawn as the desktop draws them: its colors for the appearance, the
// Parallax mark, lucide icons (the desktop's own set), text in the system's font, its attention
// marks, grouped lists as iOS Settings draws them, and Markdown, drawn natively by Enriched
// Markdown with its code, tables, LaTeX, links with their site's icon, and images that open in the
// lightbox, as the desktop's transcript renders it.
import type { LucideIcon } from "lucide-react-native";
import {
  Bot,
  Brain,
  ChevronRight,
  CircleAlert,
  Eye,
  FilePlus,
  FileText,
  FoldVertical,
  Globe,
  Hammer,
  Laptop,
  ListChecks,
  MessageCircleQuestion,
  Monitor,
  MousePointerClick,
  Pencil,
  Plug,
  Search,
  Server,
  Sparkles,
  SquareTerminal,
} from "lucide-react-native";
import {
  useEffect,
  useMemo,
  useRef,
  useState,
  type ReactNode,
} from "react";
import {
  Animated,
  Easing,
  Image,
  Linking,
  Pressable,
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
import { EnrichedMarkdownText, type MarkdownStyle } from "react-native-enriched-markdown";

import type { Attention } from "../../desktop/src/renderer/attention";
import { isHttps } from "../../desktop/src/renderer/github";
import { fileReference, filePath, unloadedImages } from "../../desktop/src/renderer/markdownLinks";
import { dollarMath } from "../../desktop/src/renderer/math";
import type { Kind } from "../../desktop/src/renderer/steps";
import { openLightbox } from "./Lightbox";
import { deviceKind } from "./machines";
import { linkedPath } from "./markdown";
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

/** Each kind of work's icon, as the desktop's `icons` (AgentChat.tsx). */
const kindIcons: Record<Exclude<Kind, "plxd">, LucideIcon> = {
  thinking: Brain,
  shell: SquareTerminal,
  reading: FileText,
  searching: Search,
  editing: Pencil,
  writing: FilePlus,
  fetching: Globe,
  agent: Bot,
  skill: Sparkles,
  mcp: Plug,
  computer: MousePointerClick,
  planning: ListChecks,
  working: Hammer,
  compacting: FoldVertical,
};

/** A kind of work's icon at trace size: Parallax's own calls wear its mark. */
export function KindIcon({ kind, color }: { kind: Kind; color: string }) {
  return kind === "plxd" ? <Mark size={15} /> : <Icon icon={kindIcons[kind]} size={15} color={color} />;
}

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
function DoneMark() {
  const c = useColors();
  return (
    <Svg width={14} height={14} viewBox="0 0 24 24">
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

// Code's syntax colors, the desktop's --syntax-* for each appearance, by tree-sitter's token kinds.
// Every kind a grammar colors is set: one left out takes the library's GitHub-dark color.
const syntax = {
  light: { keyword: "#2b5cff", string: "#c2410c", number: "#7c3aed", function: "#4338ca", type: "#be185d", comment: "#6e6c88" },
  dark: { keyword: "#7b9bff", string: "#ff8a65", number: "#c4b5fd", function: "#a5b4fc", type: "#f9a8d4", comment: "#7d7c93" },
};
const syntaxColors = (s: (typeof syntax)["light"]) => ({
  ...s,
  constant: s.number,
  tag: s.keyword,
  attribute: s.function,
  property: s.function,
});

// A web link's site mark, as the desktop's `linkIcon` draws it before the link's text, tinted.
const linkIcon = (asset: number) => Image.resolveAssetSource(asset).uri;
const linkIcons = {
  github: linkIcon(require("../assets/links/github.png")),
  linear: linkIcon(require("../assets/links/linear.png")),
  web: linkIcon(require("../assets/links/globe.png")),
};

/**
 * Markdown's look on the phone, as the desktop's transcript and T3 Code's mobile app draw it: the
 * system's font at 15, headings in weight, code in JetBrains Mono on the code fill, tables and code
 * blocks as rounded cards, and links in the accent, a web page's with its site's mark and a file's
 * as a pill. Keyed by URL patterns, so it never changes as a message streams.
 */
function markdownStyle(c: Colors, isDark: boolean): MarkdownStyle {
  const body = { color: c.foreground, fontSize: 15, lineHeight: 22, marginTop: 0, marginBottom: 12 };
  const card = { marginTop: 0, marginBottom: 12, borderRadius: 12, borderWidth: StyleSheet.hairlineWidth, borderColor: c.border };
  // More room above than below, so a heading reads with the text it opens, as the desktop's 1.4em.
  const heading = (fontSize: number) => ({
    ...body,
    fontSize,
    lineHeight: Math.round(fontSize * 1.3),
    fontWeight: "600",
    marginTop: Math.round(fontSize * 0.6),
    marginBottom: 6,
  });
  const site = (iconUri: string) => ({
    color: c.accent,
    underline: false,
    pill: { iconUri, iconTintColor: c.foreground, borderWidth: 0, borderRadius: 0, paddingHorizontal: 0, paddingVertical: 0 },
  });
  return {
    paragraph: body,
    h1: heading(20),
    h2: heading(17),
    h3: heading(15),
    h4: heading(15),
    h5: heading(15),
    h6: heading(15),
    strong: { fontWeight: "bold" },
    link: { color: c.accent, underline: false },
    linkVariants: {
      "^https?://([^/?#]*\\.)?github\\.com([/?#:]|$)": site(linkIcons.github),
      "^https?://([^/?#]*\\.)?linear\\.app([/?#:]|$)": site(linkIcons.linear),
      "^https?://": site(linkIcons.web),
      // A file in the thread's folder: a relative or absolute path, or a `file:` URL.
      "^(file:|[a-zA-Z]:[\\\\/]|(?![a-zA-Z][a-zA-Z0-9+.-]*:))": {
        color: c.accent,
        underline: false,
        fontFamily: font.mono,
        pill: { borderRadius: 5, borderWidth: StyleSheet.hairlineWidth, borderColor: c.border, paddingHorizontal: 5, paddingVertical: 1 },
        backgroundColor: c.code,
      },
    },
    code: { fontFamily: font.mono, fontSize: 13, color: c.foreground, backgroundColor: c.code, borderColor: c.border },
    codeBlock: {
      ...card,
      color: c.foreground,
      backgroundColor: c.code,
      fontFamily: font.mono,
      fontSize: 13,
      lineHeight: 20,
      padding: 14,
      syntaxColors: syntaxColors(isDark ? syntax.dark : syntax.light),
    },
    blockquote: {
      ...body,
      color: c.mutedForeground,
      borderColor: isDark ? "rgba(237, 237, 244, 0.18)" : "rgba(30, 27, 75, 0.18)",
      borderWidth: 3,
      gapWidth: 12,
      backgroundColor: "transparent",
      // GitHub's alerts (`> [!NOTE]`) in the desktop's colors for them.
      admonitions: {
        note: { color: c.accent },
        tip: { color: c.added },
        important: { color: c.projectViolet },
        warning: { color: c.warning },
        caution: { color: c.danger },
      },
    },
    list: { ...body, bulletColor: c.faintForeground, markerColor: c.faintForeground, markerFontWeight: "500", gapWidth: 7, itemSpacing: 4 },
    thematicBreak: { color: c.border, height: StyleSheet.hairlineWidth, marginTop: 10, marginBottom: 10 },
    table: {
      ...body,
      ...card,
      fontSize: 14,
      lineHeight: 20,
      headerTextColor: c.foreground,
      headerBackgroundColor: c.hover,
      rowEvenBackgroundColor: "transparent",
      rowOddBackgroundColor: "transparent",
      cellPaddingHorizontal: 12,
      cellPaddingVertical: 9,
    },
    taskList: {
      checkedColor: c.accent,
      borderColor: c.faintForeground,
      checkmarkColor: "#ffffff",
      checkboxBorderRadius: 4,
      checkedTextColor: c.foreground,
      checkedStrikethrough: false,
    },
    math: { fontSize: 15, color: c.foreground, backgroundColor: "transparent", padding: 4, marginTop: 0, marginBottom: 12, textAlign: "center" },
    inlineMath: { color: c.foreground },
    image: { borderRadius: 12, marginTop: 0, marginBottom: 12 },
  };
}

/** Follows a Markdown link: a file to `onFile`, a web page or email to the system, anything else nowhere. */
function follow(href: string, onFile?: (path: string) => void) {
  const path = linkedPath(fileReference(href));
  if (path !== undefined) onFile?.(path);
  else if (/^(https?|mailto):/i.test(href)) void Linking.openURL(href);
}

/** Which remote images Markdown loads: a pull request's https ones, or none. */
type Images = "github" | "none";

/**
 * Markdown as GitHub writes it, drawn natively by Enriched Markdown as T3 Code's mobile app draws
 * it: headings, lists and task lists, tables, quotes, code highlighted by tree-sitter with a Copy
 * button, LaTeX, and images. With `images` "github", https images load and open in the
 * lightbox, as the desktop's PR panel shows them; any other image never loads, as in the desktop's
 * transcript, and a tap follows it as a link. A link to a file, or with `onFile`, inline code
 * naming one, such as `src/App.tsx`, goes to `onFile` with its path. With `selectable` off, a long
 * press goes to what holds it, such as a message's menu.
 */
export function Markdown({
  text,
  images = "none",
  onFile,
  selectable = true,
}: {
  text: string;
  images?: Images;
  onFile?: (path: string) => void;
  selectable?: boolean;
}) {
  const shown = (url: string) => images === "github" && isHttps(url);
  const scheme = useColorScheme();
  const style = useMemo(() => markdownStyle(scheme === "dark" ? dark : light, scheme === "dark"), [scheme]);
  const markdown = useMemo(() => unloadedImages(dollarMath(text), shown), [text, images]);
  return (
    <EnrichedMarkdownText
      flavor="github"
      markdown={markdown}
      markdownStyle={style}
      md4cFlags={{ latexMath: true }}
      linkRecognition={onFile && recognition}
      selectable={selectable}
      enableCodeBlockWrapToggle
      // iOS's own link menu would open any scheme an agent writes, past `follow`.
      enableLinkPreview={false}
      onLinkPress={({ url }) => follow(url, onFile)}
      // An empty source keeps an image unrequested: a URL an agent writes can carry what it read.
      resolveImageSource={({ url }) => (shown(url) ? undefined : { uri: "" })}
      onImagePress={({ url }) => (shown(url) ? openLightbox([{ uri: url }], 0) : follow(url, onFile))}
      containerStyle={{ flexShrink: 1, minWidth: 0 }}
    />
  );
}

// Inline code that names a file becomes a link to it, as plain text, so copying keeps the Markdown.
const recognition = { inlineCode: filePath };

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
