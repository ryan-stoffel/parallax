// The pull request screens' pieces, in the layout of T3 Code's mobile app: a pull request's state
// look, avatars, +/- counts, the list's glass search and filter chips, the grouped card and its
// rows, a capsule segmented control, a body that folds past a height under a fade, the activity
// timeline, and the diff with line numbers.
import { GlassView, isLiquidGlassAvailable } from "expo-glass-effect";
import type { LucideIcon } from "lucide-react-native";
import {
  Check,
  ChevronDown,
  ChevronRight,
  ChevronUp,
  CircleMinus,
  CircleX,
  FileDiff,
  FileText,
  GitCommitHorizontal,
  GitMerge,
  GitPullRequest,
  GitPullRequestClosed,
  GitPullRequestDraft,
  MessageSquareText,
  Search,
} from "lucide-react-native";
import { useState, type ReactNode } from "react";
import { Image, Pressable, StyleSheet, TextInput, useColorScheme, View } from "react-native";
import Svg, { Defs, LinearGradient, Rect, Stop } from "react-native-svg";

import type { PrReviewState, PullRequest } from "../../desktop/src/protocol/generated/protocol";
import { githubText } from "../../desktop/src/renderer/github";
import { ago } from "./nav";
import type { Activity, DiffRow, Tone } from "./pullRequestLogic";
import { font, type Colors } from "./theme";
import { Icon, Markdown, T, useColors } from "./ui";

/** The grouped card's fill: a step off the page, light gray on light and a lifted surface on dark. */
export function useCard() {
  const c = useColors();
  return useColorScheme() === "dark" ? c.surface : c.sidebar;
}

/** A tone's color. */
export const toneColor = (tone: Tone, c: Colors) =>
  ({ success: c.added, danger: c.danger, warning: c.warning, muted: c.faintForeground })[tone];

/**
 * GitHub's own colors (Primer) for a pull request's states, light and dark: each state's icon and
 * text color, its filled pill's color behind white, and the merge button's green.
 */
const githubColors = {
  light: {
    open: "#1a7f37",
    draft: "#59636e",
    merged: "#8250df",
    closed: "#cf222e",
    openFill: "#1f883d",
    draftFill: "#59636e",
    mergedFill: "#8250df",
    closedFill: "#cf222e",
    merge: "#1f883d",
  },
  dark: {
    open: "#3fb950",
    draft: "#9198a1",
    merged: "#a371f7",
    closed: "#f85149",
    openFill: "#238636",
    draftFill: "#656c76",
    mergedFill: "#8957e5",
    closedFill: "#da3633",
    merge: "#238636",
  },
};

type GitHubColors = typeof githubColors.light;

/** GitHub's colors for the current appearance. */
export const useGitHub = (): GitHubColors => githubColors[useColorScheme() === "dark" ? "dark" : "light"];

/** Parallax's colors with GitHub's green and red, for a pull request's checks, reviews, and branch. */
export function usePrColors(): Colors {
  const gh = useGitHub();
  return { ...useColors(), added: gh.open, danger: gh.closed };
}

/** A pull request's state as GitHub draws it: its icon, its color, its word, and its pill's fill. */
export function lookOf(
  pr: Pick<PullRequest, "state" | "draft"> | undefined,
  gh: GitHubColors,
): [LucideIcon, string, string, string] {
  if (pr?.state === "merged") return [GitMerge, gh.merged, "Merged", gh.mergedFill];
  if (pr?.state === "closed") return [GitPullRequestClosed, gh.closed, "Closed", gh.closedFill];
  if (pr?.state === "open" && pr.draft) return [GitPullRequestDraft, gh.draft, "Draft", gh.draftFill];
  if (pr?.state === "open") return [GitPullRequest, gh.open, "Open", gh.openFill];
  return [GitPullRequest, gh.draft, "Pull request", gh.draftFill];
}

/** A GitHub user's picture, or their initial while it loads or when they have none. */
export function Avatar({ login, size = 24 }: { login: string; size?: number }) {
  const c = useColors();
  const card = useCard();
  const [failed, setFailed] = useState(false);
  const round = { width: size, height: size, borderRadius: size / 2 };
  return (
    <View style={[round, styles.center, { backgroundColor: card, overflow: "hidden" }]}>
      <T medium style={{ fontSize: size * 0.45, lineHeight: size * 0.6, color: c.mutedForeground }}>
        {login.slice(0, 1).toUpperCase() || "?"}
      </T>
      {!failed && (
        <Image
          accessibilityIgnoresInvertColors
          source={{ uri: `https://github.com/${login.replace(/\[bot\]$/, "")}.png?size=${size * 3}` }}
          onError={() => setFailed(true)}
          style={[round, StyleSheet.absoluteFill]}
        />
      )}
    </View>
  );
}

/** Lines added and removed, green and red. Compact leaves out a zero. */
export function DiffStats({ additions, deletions, compact }: { additions: number; deletions: number; compact?: boolean }) {
  const c = useColors();
  const size = { fontSize: compact ? 12 : 13, lineHeight: 16, fontVariant: ["tabular-nums" as const] };
  return (
    <View style={[styles.line, { gap: 6 }]}>
      {(!compact || additions > 0) && (
        <T medium style={{ ...size, color: c.added }}>
          +{additions.toLocaleString()}
        </T>
      )}
      {(!compact || deletions > 0) && (
        <T medium style={{ ...size, color: c.danger }}>
          −{deletions.toLocaleString()}
        </T>
      )}
    </View>
  );
}

/** A section's heading, as T3's: 16 pt semibold. */
export function Heading({ children }: { children: string }) {
  return <T style={{ fontSize: 16, lineHeight: 22, fontWeight: "600" }}>{children}</T>;
}

/** Rows grouped on one rounded card. */
export function CardGroup({ children }: { children: ReactNode }) {
  const c = useColors();
  return (
    <View style={[styles.card, { backgroundColor: useCard(), borderColor: c.border }]}>{children}</View>
  );
}

/**
 * A card's row: an icon, a title over an optional detail, a value at the right, and a chevron when
 * it opens something, pointing down or up when it folds rows under it.
 */
export function CardRow({
  icon,
  tint,
  title,
  detail,
  value,
  onPress,
  expanded,
  divider = true,
}: {
  icon: LucideIcon;
  tint?: string;
  title: string;
  detail?: string;
  value?: string;
  onPress?: () => void;
  expanded?: boolean;
  divider?: boolean;
}) {
  const c = useColors();
  const chevron = expanded === undefined ? ChevronRight : expanded ? ChevronUp : ChevronDown;
  return (
    <Pressable
      accessibilityRole={onPress ? "button" : undefined}
      accessibilityState={expanded === undefined ? undefined : { expanded }}
      disabled={!onPress}
      onPress={onPress}
      style={({ pressed }) => [
        styles.row,
        divider && { borderBottomWidth: StyleSheet.hairlineWidth, borderBottomColor: c.border },
        pressed && { opacity: 0.6 },
      ]}
    >
      <Icon icon={icon} size={18} color={tint ?? c.faintForeground} />
      <View style={{ flex: 1, gap: 2 }}>
        <T medium style={{ fontSize: 14, lineHeight: 19, color: c.foreground }}>
          {title}
        </T>
        {!!detail && (
          <T muted numberOfLines={2} style={styles.caption}>
            {detail}
          </T>
        )}
      </View>
      {!!value && (
        <T muted numberOfLines={2} style={{ ...styles.caption, maxWidth: "40%", textAlign: "right" }}>
          {value}
        </T>
      )}
      {onPress && <Icon icon={chevron} size={12} color={c.faintForeground} strokeWidth={2.4} />}
    </Pressable>
  );
}

const glass = isLiquidGlassAvailable();

/**
 * A filter's glass chip, as T3's: its label and a chevron, filled with the accent while it narrows
 * the list. Where the system has no Liquid Glass, a translucent capsule.
 */
export function GlassChip({
  label,
  active,
  icon,
  accessibilityLabel,
  onPress,
}: {
  label: string;
  active?: boolean;
  /** In place of the chevron, such as an X for Clear. */
  icon?: LucideIcon;
  accessibilityLabel?: string;
  onPress: () => void;
}) {
  const c = useColors();
  const fg = active ? "#ffffff" : c.foreground;
  const body = (
    <>
      <T medium numberOfLines={1} style={{ fontSize: 13, lineHeight: 17, color: fg, maxWidth: 180 }}>
        {label}
      </T>
      <Icon icon={icon ?? ChevronDown} size={12} color={active ? fg : c.mutedForeground} strokeWidth={2.4} />
    </>
  );
  return (
    <Pressable
      accessibilityRole="button"
      accessibilityLabel={accessibilityLabel ?? label}
      accessibilityState={{ selected: !!active }}
      hitSlop={4}
      onPress={onPress}
      style={({ pressed }) => pressed && { opacity: 0.7 }}
    >
      {glass ? (
        <GlassView isInteractive tintColor={active ? c.accent : undefined} style={styles.chip}>
          {body}
        </GlassView>
      ) : (
        <View style={[styles.chip, { backgroundColor: active ? c.accent : c.selected }]}>{body}</View>
      )}
    </Pressable>
  );
}

/** A glass capsule around a search box, with a clear button once there's text. */
export function GlassSearch({
  value,
  onChange,
  placeholder,
}: {
  value: string;
  onChange: (text: string) => void;
  placeholder: string;
}) {
  const c = useColors();
  const body = (
    <>
      <Icon icon={Search} size={17} color={c.mutedForeground} />
      <TextInput
        accessibilityLabel={placeholder}
        value={value}
        onChangeText={onChange}
        placeholder={placeholder}
        placeholderTextColor={c.faintForeground}
        selectionColor={c.accent}
        autoCapitalize="none"
        autoCorrect={false}
        returnKeyType="search"
        clearButtonMode="never"
        style={[styles.input, { color: c.foreground }]}
      />
      {!!value && (
        <Pressable accessibilityRole="button" accessibilityLabel="Clear search" hitSlop={10} onPress={() => onChange("")}>
          <Icon icon={CircleX} size={17} color={c.faintForeground} />
        </Pressable>
      )}
    </>
  );
  return glass ? (
    <GlassView style={styles.field}>{body}</GlassView>
  ) : (
    <View style={[styles.field, { backgroundColor: c.selected }]}>{body}</View>
  );
}

/** A capsule of choices, the chosen one on a raised pill, as T3's segmented control. */
export function Segmented<V extends string>({
  options,
  value,
  onChange,
}: {
  options: { value: V; label: string }[];
  value: V;
  onChange: (value: V) => void;
}) {
  const c = useColors();
  const dark = useColorScheme() === "dark";
  return (
    <View style={[styles.segments, { backgroundColor: useCard() }]}>
      {options.map((o) => {
        const on = o.value === value;
        return (
          <Pressable
            key={o.value}
            accessibilityRole="tab"
            accessibilityState={{ selected: on }}
            onPress={() => onChange(o.value)}
            style={[
              styles.segment,
              on && { backgroundColor: dark ? c.border : c.background },
              on && !dark && styles.raised,
            ]}
          >
            <T style={{ fontSize: 13, lineHeight: 17, fontWeight: on ? "600" : "500", color: on ? c.foreground : c.mutedForeground }}>
              {o.label}
            </T>
          </Pressable>
        );
      })}
    </View>
  );
}

/**
 * Children that fold to `height` under a fade into `fill` once they're taller, with Show more and
 * Show less, as T3 folds a long description or comment.
 */
export function Folding({ height, fill, children }: { height: number; fill: string; children: ReactNode }) {
  const c = useColors();
  const [full, setFull] = useState(0);
  const [open, setOpen] = useState(false);
  const folds = full > height + 40;
  const folded = folds && !open;
  return (
    <View>
      <View style={{ height: folded ? height : full || undefined, overflow: "hidden" }}>
        {/* Measured on its own, so the clipped box doesn't change what it measures. */}
        <View style={styles.measure} onLayout={(e) => setFull(e.nativeEvent.layout.height)}>
          {children}
        </View>
      </View>
      {folded && (
        <View pointerEvents="none" style={styles.fade}>
          <Svg width="100%" height={80}>
            <Defs>
              <LinearGradient id="fold" x1="0" y1="0" x2="0" y2="80" gradientUnits="userSpaceOnUse">
                <Stop offset="0" stopColor={fill} stopOpacity={0} />
                <Stop offset="0.5" stopColor={fill} stopOpacity={0.94} />
                <Stop offset="0.72" stopColor={fill} stopOpacity={1} />
              </LinearGradient>
            </Defs>
            <Rect width="100%" height="100%" fill="url(#fold)" />
          </Svg>
        </View>
      )}
      {folds && (
        <Pressable
          accessibilityRole="button"
          accessibilityState={{ expanded: open }}
          onPress={() => setOpen(!open)}
          style={({ pressed }) => [styles.more, folded && styles.moreOver, pressed && { opacity: 0.6 }]}
        >
          <T medium style={{ fontSize: 13, lineHeight: 17 }}>
            {open ? "Show less" : "Show more"}
          </T>
          <Icon icon={open ? ChevronUp : ChevronDown} size={11} color={c.foreground} strokeWidth={2.4} />
        </Pressable>
      )}
    </View>
  );
}

const verdictWords: Record<PrReviewState, string> = {
  approved: "approved",
  changesRequested: "requested changes",
  commented: "commented",
  dismissed: "was dismissed",
};

/** A verdict's timeline icon and color. */
function verdictLook(verdict: PrReviewState | undefined, c: Colors, gh: GitHubColors): [LucideIcon, string] {
  if (verdict === "approved") return [Check, gh.open];
  if (verdict === "changesRequested") return [FileDiff, gh.closed];
  if (verdict === "dismissed") return [CircleMinus, c.faintForeground];
  return [MessageSquareText, c.faintForeground];
}

/**
 * One event on the timeline: its icon in a ring on the line at the left, its content beside it.
 * With `fill`, the ring is filled and the icon white, as GitHub marks a merge or a close.
 */
function Event({
  icon,
  color,
  fill,
  last,
  children,
}: {
  icon: LucideIcon;
  color?: string;
  fill?: string;
  last: boolean;
  children: ReactNode;
}) {
  const c = useColors();
  const card = useCard();
  return (
    <View style={{ flexDirection: "row", gap: 12 }}>
      <View style={{ width: 32, alignItems: "center" }}>
        {!last && <View style={[styles.rail, { backgroundColor: c.border }]} />}
        <View style={[styles.ring, { backgroundColor: fill ?? card, borderColor: fill ?? c.border }]}>
          <Icon icon={icon} size={15} color={fill ? "#ffffff" : color} />
        </View>
      </View>
      <View style={{ flex: 1, gap: 8, paddingTop: 5, paddingBottom: 24 }}>{children}</View>
    </View>
  );
}

/** Who did what, and when, at the top of an event. */
function Byline({ author, action, at }: { author?: string; action: string; at: string }) {
  return (
    <View style={[styles.line, { gap: 8 }]}>
      {author && <Avatar login={author} size={22} />}
      <T numberOfLines={1} style={{ flex: 1, fontSize: 14, lineHeight: 19 }}>
        {author && <T medium style={{ fontSize: 14, lineHeight: 19 }}>{author}</T>}
        <T muted style={{ fontSize: 14, lineHeight: 19 }}>
          {author ? ` ${action}` : action[0]!.toUpperCase() + action.slice(1)}
        </T>
      </T>
      <T faint style={styles.caption}>
        {ago(at)}
      </T>
    </View>
  );
}

/** The activity tab: comments with their GitHub images, verdicts, commits, and the merge or close. */
export function Timeline({ events }: { events: Activity[] }) {
  const c = useColors();
  const gh = useGitHub();
  const card = useCard();
  if (!events.length)
    return (
      <T muted style={{ fontSize: 14, paddingVertical: 24 }}>
        No activity yet.
      </T>
    );
  return (
    <View>
      {events.map((e, i) => {
        const last = i === events.length - 1;
        if (e.kind === "commit")
          return (
            <Event key={i} icon={GitCommitHorizontal} color={c.faintForeground} last={last}>
              <View style={[styles.line, { gap: 8 }]}>
                <Avatar login={e.author} size={22} />
                <T numberOfLines={1} style={{ flex: 1, fontSize: 14, lineHeight: 19 }}>
                  {e.headline}
                </T>
                <T faint style={{ ...styles.caption, fontFamily: font.mono }}>
                  {e.oid.slice(0, 7)}
                </T>
              </View>
            </Event>
          );
        if (e.kind === "merged" || e.kind === "closed")
          return (
            <Event
              key={i}
              icon={e.kind === "merged" ? GitMerge : GitPullRequestClosed}
              fill={e.kind === "merged" ? gh.mergedFill : gh.closedFill}
              last={last}
            >
              <Byline author={e.author} action={e.kind === "merged" ? "merged this" : "closed this"} at={e.at} />
            </Event>
          );
        const [icon, color] = verdictLook(e.verdict, c, gh);
        return (
          <Event key={i} icon={icon} color={color} last={last}>
            <Byline author={e.author} action={verdictWords[e.verdict ?? "commented"]} at={e.at} />
            {e.kind === "comment" && !!e.body.trim() && (
              <View style={[styles.bubble, { backgroundColor: card }]}>
                <Folding height={240} fill={card}>
                  <Markdown text={githubText(e.body)} images="github" />
                </Folding>
              </View>
            )}
          </Event>
        );
      })}
    </View>
  );
}

/** A diff row: a file's header, a hunk's `@@` line, or a numbered line on green, red, or nothing. */
export function DiffLine({ row }: { row: DiffRow }) {
  const c = useColors();
  const card = useCard();
  if (row.kind === "file") {
    const slash = row.path.lastIndexOf("/");
    return (
      <View style={[styles.diffFile, { backgroundColor: card, borderColor: c.border }]}>
        <Icon icon={FileText} size={15} color={c.faintForeground} />
        <T numberOfLines={1} style={{ flex: 1, fontSize: 13, lineHeight: 17 }}>
          <T muted style={{ fontSize: 13, lineHeight: 17 }}>
            {row.path.slice(0, slash + 1)}
          </T>
          <T medium style={{ fontSize: 13, lineHeight: 17 }}>
            {row.path.slice(slash + 1)}
          </T>
        </T>
        <DiffStats additions={row.additions} deletions={row.deletions} compact />
      </View>
    );
  }
  if (row.kind === "hunk")
    return (
      <T numberOfLines={1} style={{ ...styles.code, color: c.mutedForeground, backgroundColor: c.selected, paddingHorizontal: 10, paddingVertical: 3 }}>
        {row.text}
      </T>
    );
  const tint =
    row.kind === "add" ? "rgba(22, 163, 74, 0.14)" : row.kind === "del" ? "rgba(212, 51, 15, 0.13)" : undefined;
  const gutter =
    row.kind === "add" ? "rgba(22, 163, 74, 0.22)" : row.kind === "del" ? "rgba(212, 51, 15, 0.2)" : undefined;
  return (
    <View style={{ flexDirection: "row", backgroundColor: tint }}>
      <T style={{ ...styles.code, ...styles.gutter, color: c.faintForeground, backgroundColor: gutter }}>{row.line}</T>
      <T style={{ ...styles.code, flex: 1, paddingLeft: 8, paddingRight: 10 }}>{row.text || " "}</T>
    </View>
  );
}

const styles = StyleSheet.create({
  center: { alignItems: "center", justifyContent: "center" },
  line: { flexDirection: "row", alignItems: "center" },
  caption: { fontSize: 12, lineHeight: 16 },
  card: { borderRadius: 22, borderWidth: StyleSheet.hairlineWidth, overflow: "hidden" },
  row: { minHeight: 46, flexDirection: "row", alignItems: "center", gap: 12, paddingHorizontal: 16, paddingVertical: 11 },
  chip: { flexDirection: "row", alignItems: "center", gap: 6, height: 34, paddingHorizontal: 14, borderRadius: 17, overflow: "hidden" },
  field: { height: 44, flexDirection: "row", alignItems: "center", gap: 8, paddingHorizontal: 14, borderRadius: 22, overflow: "hidden" },
  input: { flex: 1, height: 44, fontSize: 16 },
  segments: { flexDirection: "row", borderRadius: 999, padding: 3, minHeight: 34 },
  segment: { flex: 1, alignItems: "center", justifyContent: "center", borderRadius: 999, paddingVertical: 6 },
  raised: { shadowColor: "#000000", shadowOpacity: 0.08, shadowRadius: 3, shadowOffset: { width: 0, height: 1 } },
  measure: { position: "absolute", top: 0, left: 0, right: 0 },
  fade: { position: "absolute", left: 0, right: 0, bottom: 0, height: 80 },
  more: { minHeight: 40, flexDirection: "row", alignItems: "center", justifyContent: "center", gap: 4 },
  moreOver: { position: "absolute", left: 0, right: 0, bottom: 0 },
  rail: { position: "absolute", top: 0, bottom: 0, width: StyleSheet.hairlineWidth * 2 },
  ring: { width: 32, height: 32, borderRadius: 16, borderWidth: StyleSheet.hairlineWidth, alignItems: "center", justifyContent: "center" },
  bubble: { borderRadius: 16, padding: 12 },
  code: { fontFamily: font.mono, fontSize: 11.5, lineHeight: 17 },
  gutter: { width: 44, textAlign: "right", paddingRight: 6 },
  diffFile: {
    flexDirection: "row",
    alignItems: "center",
    gap: 8,
    marginTop: 12,
    paddingHorizontal: 12,
    paddingVertical: 10,
    borderTopWidth: StyleSheet.hairlineWidth,
    borderBottomWidth: StyleSheet.hairlineWidth,
  },
});
