// Account, from the Settings sheet's profile row, as the desktop's Account dialog has it: the
// profile card, with a banner in the mark's colors, the picture, name, and email, and what every
// computer's agents add up to, counted as the desktop counts them (activity.ts); then the
// account's settings, when its agents ran, its security, and Parallax Connect. An OAuth token
// can't change the user (Account.tsx), so Edit and Security open Clerk's account pages.
import {
  Bot,
  CalendarDays,
  Flame,
  FolderGit2,
  GitPullRequest,
  Trophy,
  type LucideIcon,
} from "lucide-react-native";
import { t } from "i18next";
import { useMemo, useState } from "react";
import { Linking, ScrollView, StyleSheet, Text, View } from "react-native";
import Svg, { Circle, Defs, LinearGradient, RadialGradient, Rect, Stop } from "react-native-svg";

import { activityOf, dayOf, rhythmOf } from "../../desktop/src/renderer/activity";
import { isRepository } from "../../desktop/src/renderer/threads";
import { Avatar, nameOf, PORTAL, useAccount } from "./Account";
import { showAlert } from "./dialogStore";
import { useFleet } from "./fleet";
import { useNav } from "./nav";
import { Action, Section } from "./SettingsParts";
import { font } from "./theme";
import { Icon, Mark, Row, T, useColors } from "./ui";

const monthYear = new Intl.DateTimeFormat(undefined, { month: "long", year: "numeric" });
const shortDay = new Intl.DateTimeFormat(undefined, { weekday: "short", month: "short", day: "numeric" });
const hourName = new Intl.DateTimeFormat(undefined, { hour: "numeric" });

const SECURITY = `${PORTAL}/user/security`;

/** A soft disc of `color`, fading to nothing at its edge, as the desktop blurs the banner's circles. */
function Glow({ id, color, size, top, right, opacity }: { id: string; color: string; size: number; top: number; right: number; opacity: number }) {
  return (
    <Svg width={size} height={size} style={{ position: "absolute", top, right }}>
      <Defs>
        <RadialGradient id={id} cx="50%" cy="50%" r="50%">
          <Stop offset="0" stopColor={color} stopOpacity={opacity} />
          <Stop offset="1" stopColor={color} stopOpacity={0} />
        </RadialGradient>
      </Defs>
      <Circle cx={size / 2} cy={size / 2} r={size / 2} fill={`url(#${id})`} />
    </Svg>
  );
}

/** The card's banner: a wash of the mark's two colors, their circles large and soft, and the mark. */
function Banner() {
  const c = useColors();
  return (
    <View style={styles.banner}>
      <Svg width="100%" height="100%" style={StyleSheet.absoluteFill}>
        <Defs>
          <LinearGradient id="wash" x1="0" y1="0" x2="1" y2="0.5">
            <Stop offset="0" stopColor={c.markBlue} stopOpacity={0.22} />
            <Stop offset="1" stopColor={c.markCoral} stopOpacity={0.18} />
          </LinearGradient>
        </Defs>
        <Rect width="100%" height="100%" fill="url(#wash)" />
      </Svg>
      <Glow id="blueGlow" color={c.markBlue} size={208} top={-64} right={96} opacity={0.35} />
      <Glow id="coralGlow" color={c.markCoral} size={176} top={-16} right={0} opacity={0.3} />
      <View style={{ position: "absolute", right: 28, top: 24, opacity: 0.9 }}>
        <Mark size={64} />
      </View>
    </View>
  );
}

const tones = { blue: "markBlue", coral: "markCoral" } as const;

/** One of the card's stats: its icon in a soft square of its tone, its label, and its number. */
function Stat({
  icon,
  tone,
  label,
  value,
  unit,
}: {
  icon: LucideIcon;
  tone: keyof typeof tones | "off";
  label: string;
  value: number;
  unit?: string;
}) {
  const c = useColors();
  const color = tone === "off" ? c.faintForeground : c[tones[tone]];
  return (
    <View style={[styles.stat, { backgroundColor: c.background, borderColor: c.border }]}>
      <View style={[styles.statIcon, { backgroundColor: tone === "off" ? c.selected : `${color}26` }]}>
        <Icon icon={icon} size={16} color={color} />
      </View>
      <T muted style={{ fontSize: 12, lineHeight: 16, marginTop: 12 }}>
        {label}
      </T>
      <Text style={[styles.number, { color: c.foreground }]}>
        {value.toLocaleString("en")}
        {unit && <Text style={{ fontSize: 16, color: c.mutedForeground }}>{unit}</Text>}
      </Text>
    </View>
  );
}

/** The Parallax account: its card, its settings, its activity, its security, and Parallax Connect. */
export function AccountScreen() {
  const c = useColors();
  const nav = useNav();
  const { user, signOut } = useAccount();
  const { computers, defaultId } = useFleet();
  const [now] = useState(Date.now);
  const activity = useMemo(
    () => activityOf(computers.flatMap((m) => Object.values(m.view.state.runs)), now),
    [computers, now],
  );
  const repos = computers.reduce((n, m) => n + m.view.state.repos.filter(isRepository).length, 0);
  const name = nameOf(user);
  const email = user?.email;

  const chips: { icon: LucideIcon; text: string }[] = [];
  if (activity.since) chips.push({ icon: CalendarDays, text: t("Building since {{date}}", { date: monthYear.format(activity.since) }) });
  if (repos > 0) chips.push({ icon: FolderGit2, text: t("{{count}} repositories", { count: repos, defaultValue_one: "{{count}} repository" }) });

  const busiestHour = activity.hours.indexOf(Math.max(...activity.hours));
  const security = () => void Linking.openURL(SECURITY);

  return (
    <ScrollView
      style={{ backgroundColor: c.background }}
      contentInsetAdjustmentBehavior="automatic"
      contentContainerStyle={{ padding: 16, paddingTop: 8, gap: 24, paddingBottom: 40 }}
    >
      <View style={[styles.card, { backgroundColor: c.surface, borderColor: c.border }]}>
        <Banner />
        <View style={{ paddingHorizontal: 18, paddingBottom: 18 }}>
          <View style={[styles.ring, { backgroundColor: c.surface }]}>
            <Avatar size={80} />
          </View>
          <Text numberOfLines={1} style={[styles.name, { color: c.foreground }]}>
            {name ?? email ?? t("Parallax account")}
          </Text>
          {!!name && !!email && (
            <T muted numberOfLines={1} style={{ fontSize: 13, lineHeight: 18 }}>
              {email}
            </T>
          )}
          {chips.length > 0 && (
            <View style={styles.chips}>
              {chips.map(({ icon, text }) => (
                <View key={text} style={[styles.chip, { backgroundColor: c.selected }]}>
                  <Icon icon={icon} size={13} color={c.mutedForeground} />
                  <T muted style={{ fontSize: 12, lineHeight: 16 }}>
                    {text}
                  </T>
                </View>
              ))}
            </View>
          )}
          <View style={styles.stats}>
            <Stat icon={Bot} tone="blue" label={t("Agents")} value={activity.agents} />
            <Stat icon={GitPullRequest} tone="blue" label={t("Pull requests")} value={activity.pullRequests} />
            <Stat icon={Trophy} tone="coral" label={t("Longest streak")} value={activity.longest} unit={t("d", { context: "days" })} />
            <Stat icon={Flame} tone={activity.current ? "coral" : "off"} label={t("Current streak")} value={activity.current} unit={t("d", { context: "days" })} />
          </View>
          {computers.length > 1 && (
            <T faint style={{ fontSize: 12, lineHeight: 16, marginTop: 12 }}>
              {t("Across {{count}} computers", { count: computers.length, defaultValue_one: "Across {{count}} computer" })}
            </T>
          )}
        </View>
      </View>

      <Section title={t("Account settings")}>
        <Row
          title={t("Name")}
          detail={name ?? t("Shown on your profile and in the sidebar.")}
          right={<Action label={t("Edit")} onPress={() => void Linking.openURL(`${PORTAL}/user`)} />}
        />
        <Row title={t("Email")} detail={email ?? t("None")} />
        <Row
          title={t("Sign out")}
          detail={t("Only on this phone. Your other devices stay signed in.")}
          last
          right={
            <Action
              label={t("Sign out")}
              destructive
              onPress={() =>
                showAlert(t("Sign out of Parallax?"), t("Your computers stay on this phone."), [
                  { text: t("Cancel"), style: "cancel" },
                  { text: t("Sign out"), style: "destructive", onPress: () => void signOut() },
                ])
              }
            />
          }
        />
      </Section>

      {activity.busiest && (
        <Section title={t("Activity")} footer={t("When your agents started, on every computer.")}>
          <Row
            title={t("When you build")}
            detail={t("{{rhythm}} · busiest around {{hour}}", { rhythm: t(rhythmOf(busiestHour)), hour: hourName.format(new Date(2000, 0, 1, busiestHour)) })}
          />
          <Row
            title={t("Busiest day")}
            detail={t("{{day}} · {{count}} agents", { day: shortDay.format(dayOf(activity.busiest.day)), count: activity.busiest.agents, defaultValue_one: "{{day}} · {{count}} agent" })}
            last
          />
        </Section>
      )}

      <Section title={t("Security")} footer={t("Each opens your account's security page on Clerk.")}>
        <Row
          title={t("Password")}
          detail={t("Set or change the password you sign in with by email.")}
          right={<Action label={t("Set")} onPress={security} />}
        />
        <Row
          title={t("Passkeys")}
          detail={t("Sign in with Face ID, Touch ID, or a security key.")}
          right={<Action label={t("Add")} onPress={security} />}
        />
        <Row
          title={t("Delete account")}
          detail={t("Deletes your Parallax account and signs out every device.")}
          last
          right={<Action label={t("Delete")} destructive onPress={security} />}
        />
      </Section>

      <Section title="Parallax Connect" footer={t("The computers you add with plx connect join this phone on their own.")}>
        <Row
          title={t("Computers")}
          detail={t("{{count}} on this phone", { count: computers.length })}
          chevron
          last
          onPress={() =>
            nav.navigate("ComputerSettings", { id: defaultId ?? computers[0]?.machine.id ?? "", page: "connections" })
          }
        />
      </Section>
    </ScrollView>
  );
}

const styles = StyleSheet.create({
  card: { borderRadius: 18, borderCurve: "continuous", borderWidth: StyleSheet.hairlineWidth, overflow: "hidden" },
  banner: { height: 112, overflow: "hidden" },
  ring: { alignSelf: "flex-start", marginTop: -44, padding: 4, borderRadius: 999 },
  name: { fontFamily: font.brand, fontSize: 24, lineHeight: 31, marginTop: 10 },
  chips: { flexDirection: "row", flexWrap: "wrap", gap: 6, marginTop: 12 },
  chip: { flexDirection: "row", alignItems: "center", gap: 6, paddingHorizontal: 10, paddingVertical: 3, borderRadius: 999 },
  stats: { flexDirection: "row", flexWrap: "wrap", gap: 10, marginTop: 20 },
  stat: {
    flexGrow: 1,
    flexBasis: "40%",
    padding: 14,
    borderRadius: 12,
    borderCurve: "continuous",
    borderWidth: StyleSheet.hairlineWidth,
  },
  statIcon: { width: 28, height: 28, borderRadius: 8, borderCurve: "continuous", alignItems: "center", justifyContent: "center" },
  number: { fontFamily: font.brand, fontSize: 24, lineHeight: 31, fontVariant: ["tabular-nums"] },
});
