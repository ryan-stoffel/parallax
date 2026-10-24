// The app's shared pieces, drawn as the desktop draws them: its colors for the appearance, the
// Parallax mark, lucide icons (the desktop's own set), text in the system's font, its attention
// marks, grouped lists as iOS Settings draws them, and Markdown with images that open in the
// lightbox.
import type { LucideIcon } from "lucide-react-native";
import {
  ChevronRight,
  CircleAlert,
  Eye,
  Laptop,
  MessageCircleQuestion,
  Monitor,
  Server,
} from "lucide-react-native";
import { marked, type Token, type Tokens } from "marked";
import { useEffect, useRef, useState, type ReactNode } from "react";
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
import Svg, { Circle, ClipPath, Defs, LinearGradient, Path, RadialGradient, Rect, Stop } from "react-native-svg";

import type { Attention } from "../../desktop/src/renderer/attention";
import { onGithub } from "../../desktop/src/renderer/github";
import { openLightbox } from "./Lightbox";
import { deviceKind } from "./machines";
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

/** "Parallax" in the brand's Sora, as the desktop's wordmark. */
export function Wordmark({ size = 20, nightly }: { size?: number; nightly?: boolean }) {
  const c = useColors();
  return (
    <View style={{ flexDirection: "row", alignItems: "center", gap: 8 }}>
      <Mark size={size + 4} />
      <Text style={{ fontFamily: font.brand, fontSize: size, color: c.foreground }}>Parallax</Text>
      {nightly && <NightlyBadge />}
    </View>
  );
}

/** The nightly channel's tag: its night sky, as the desktop's send button wears it. */
export function NightlyBadge() {
  return (
    <View style={{ borderRadius: 999, overflow: "hidden" }}>
      <NightSky width={64} height={20} />
      <Text style={styles.nightly}>Nightly</Text>
    </View>
  );
}

// A few fixed stars, as the desktop's .send-sky has them.
const stars: [number, number, number, number][] = [
  [0.28, 0.26, 0.8, 1],
  [0.66, 0.2, 0.6, 0.8],
  [0.78, 0.46, 0.7, 0.7],
  [0.4, 0.5, 0.5, 0.6],
  [0.14, 0.64, 0.5, 0.5],
  [0.88, 0.72, 0.5, 0.6],
];

/** The nightly build's sky (index.css's .send-sky): indigo, a violet glow, and stars. */
export function NightSky({ width, height }: { width: number; height: number }) {
  return (
    <Svg width={width} height={height} style={StyleSheet.absoluteFill}>
      <Defs>
        <LinearGradient id="sky" x1="0" y1="0" x2="0" y2="1">
          <Stop offset="0" stopColor="#070923" />
          <Stop offset="0.6" stopColor="#17184f" />
          <Stop offset="1" stopColor="#2a2470" />
        </LinearGradient>
        <RadialGradient id="glow" cx="0.7" cy="0.1" r="0.6">
          <Stop offset="0" stopColor="#7c3aed" stopOpacity={0.45} />
          <Stop offset="1" stopColor="#7c3aed" stopOpacity={0} />
        </RadialGradient>
      </Defs>
      <Rect width={width} height={height} fill="url(#sky)" />
      <Rect width={width} height={height} fill="url(#glow)" />
      {stars.map(([x, y, r, o], i) => (
        <Circle key={i} cx={x * width} cy={y * height} r={r} fill="#ffffff" opacity={o} />
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

/** Inline Markdown: bold, italics, code, links, and struck text, inside a `Text`. */
function Inline({ tokens }: { tokens?: Token[] }): ReactNode {
  const c = useColors();
  return tokens?.map((t, i) => {
    switch (t.type) {
      case "strong":
        return (
          <Text key={i} style={{ fontWeight: "600" }}>
            <Inline tokens={t.tokens} />
          </Text>
        );
      case "em":
        return (
          <Text key={i} style={{ fontStyle: "italic" }}>
            <Inline tokens={t.tokens} />
          </Text>
        );
      case "del":
        return (
          <Text key={i} style={{ textDecorationLine: "line-through" }}>
            <Inline tokens={t.tokens} />
          </Text>
        );
      case "codespan":
        return (
          <Text key={i} style={{ fontFamily: font.mono, fontSize: 13, backgroundColor: c.code }}>
            {` ${unescape((t as Tokens.Codespan).text)} `}
          </Text>
        );
      case "link":
        return (
          <Text
            key={i}
            style={{ color: c.accent }}
            onPress={() => void Linking.openURL((t as Tokens.Link).href)}
          >
            <Inline tokens={t.tokens} />
          </Text>
        );
      case "image":
        // Images show as blocks (`Block`); left inline, one is its alt text.
        return (t as Tokens.Image).text;
      case "br":
        return "\n";
      case "checkbox":
        return null;
      case "text":
        return "tokens" in t && t.tokens ? (
          <Inline key={i} tokens={t.tokens} />
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

interface BlockProps {
  token: Token;
  images: Images;
  all: () => string[];
}

function Block({ token, images, all }: BlockProps): ReactNode {
  const c = useColors();
  switch (token.type) {
    case "space":
    // A task's box, which the list draws itself.
    case "checkbox":
      return null;
    case "hr":
      return <View style={{ height: StyleSheet.hairlineWidth, backgroundColor: c.border }} />;
    case "heading": {
      const size = [0, 21, 18, 16, 15, 15, 15][(token as Tokens.Heading).depth]!;
      return (
        <T style={{ fontSize: size, lineHeight: size * 1.35, fontWeight: "600", marginTop: 4 }}>
          <Inline tokens={token.tokens} />
        </T>
      );
    }
    case "code":
      return (
        <View style={[styles.code, { backgroundColor: c.code, borderColor: c.border }]}>
          <Text
            selectable
            style={{ fontFamily: font.mono, fontSize: 12, lineHeight: 18, color: c.foreground }}
          >
            {(token as Tokens.Code).text}
          </Text>
        </View>
      );
    case "blockquote":
      return (
        <View style={{ borderLeftWidth: 3, borderLeftColor: c.border, paddingLeft: 10 }}>
          <Blocks tokens={(token as Tokens.Blockquote).tokens} images={images} all={all} />
        </View>
      );
    case "list": {
      const list = token as Tokens.List;
      const start = typeof list.start === "number" ? list.start : 1;
      return (
        <View style={{ gap: 4 }}>
          {list.items.map((item, i) => (
            <View key={i} style={{ flexDirection: "row", gap: 8 }}>
              <T muted style={{ minWidth: 14 }}>
                {item.task ? (item.checked ? "☑" : "☐") : list.ordered ? `${start + i}.` : "•"}
              </T>
              <View style={{ flex: 1 }}>
                <Blocks tokens={item.tokens} images={images} all={all} />
              </View>
            </View>
          ))}
        </View>
      );
    }
    case "table": {
      const table = token as Tokens.Table;
      return (
        <View style={[styles.code, { borderColor: c.border, padding: 0 }]}>
          {[table.header, ...table.rows].map((row, i) => (
            <View
              key={i}
              style={{
                flexDirection: "row",
                borderTopWidth: i ? StyleSheet.hairlineWidth : 0,
                borderColor: c.border,
              }}
            >
              {row.map((cell, j) => (
                <T key={j} medium={i === 0} style={{ flex: 1, padding: 6, fontSize: 13 }}>
                  <Inline tokens={cell.tokens} />
                </T>
              ))}
            </View>
          ))}
        </View>
      );
    }
    case "paragraph":
    case "text": {
      const tokens = "tokens" in token ? token.tokens : undefined;
      const pictures = images === "github" ? imagesIn(tokens).filter((t) => onGithub(t.href)) : [];
      const words = tokens?.filter((t) => t.type !== "image" || !pictures.includes(t as Tokens.Image));
      const hasText = words?.some((t) => t.raw.trim());
      return (
        <View style={{ gap: 8 }}>
          {hasText && (
            <T selectable>
              <Inline tokens={words} />
            </T>
          )}
          {pictures.map((p, i) => (
            <MarkdownImage key={i} src={p.href} alt={p.text} all={all} />
          ))}
        </View>
      );
    }
    default:
      return token.raw.trim() ? <T>{token.raw.trim()}</T> : null;
  }
}

function Blocks({ tokens, images, all }: { tokens: Token[]; images: Images; all: () => string[] }) {
  return (
    <View style={{ gap: 10 }}>
      {tokens.map((t, i) => (
        <Block key={i} token={t} images={images} all={all} />
      ))}
    </View>
  );
}

/**
 * Markdown, as GitHub writes it: headings, lists, tables, quotes, code, and links. With `images`
 * "github", GitHub-hosted images show and open in the lightbox, as the desktop's PR panel shows
 * them; an agent's remote images stay links, as in the desktop's transcript.
 */
export function Markdown({ text, images = "none" }: { text: string; images?: Images }) {
  const tokens = marked.lexer(text);
  const all = () =>
    images === "github"
      ? imagesIn(tokens.flatMap((t) => ("tokens" in t ? (t.tokens ?? []) : [t])))
          .map((t) => t.href)
          .filter(onGithub)
      : [];
  return <Blocks tokens={tokens} images={images} all={all} />;
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
  nightly: {
    color: "#ffffff",
    fontSize: 11,
    fontWeight: "600",
    paddingHorizontal: 9,
    paddingVertical: 3,
    textAlign: "center",
  },
  badge: { flexDirection: "row", alignItems: "center", gap: 4 },
  badgeText: { fontSize: 12, fontWeight: "500", fontVariant: ["tabular-nums"] },
  code: { borderWidth: StyleSheet.hairlineWidth, borderRadius: 10, padding: 10 },
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
