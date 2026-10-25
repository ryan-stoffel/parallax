// Settings, a sheet from the sidebar's profile picture, laid out as Claude's: the account's card,
// then the computers (each with its own page: status, default, reconnect, remove, and its
// settings, SettingsComputer.tsx), usage, notifications by kind with a test, appearance,
// Tailscale, and the account's security and sign out, each row's icon in a soft square of its
// color. About, from the sheet's info button, has the version and links. What the desktop's
// Settings keeps on the desktop itself, such as its window, fonts, shortcuts, editors, terminal,
// and updates, stays there.
import type { NativeStackScreenProps } from "@react-navigation/native-stack";
import {
  BellOff,
  BellRing,
  Bot,
  Bug,
  CalendarClock,
  ChartColumn,
  ChevronRight,
  CircleCheck,
  CircleX,
  GitBranch,
  HardDrive,
  Hand,
  Info,
  KeyRound,
  LockKeyhole,
  LogOut,
  MessagesSquare,
  Moon,
  MousePointerClick,
  Network,
  Plus,
  RefreshCw,
  Send,
  Smartphone,
  SquareTerminal,
  Star,
  Sun,
  Trash2,
  type LucideIcon,
} from "lucide-react-native";
import { useEffect, useState } from "react";
import { Alert, AppState, Linking, Pressable, ScrollView, StyleSheet, Switch, View } from "react-native";

import { appVersion, tailnetAddress } from "../modules/pinned-tls";
import { Avatar, nameOf, PORTAL, useAccount } from "./Account";
import { useComputer, useFleet, type Computer } from "./fleet";
import { useNav, type Screens } from "./nav";
import { FindComputers } from "./Onboarding";
import { setPrefs, usePrefs, type Prefs } from "./prefs";
import { askForNotifications, notificationsOn, notify, registerWithRelay } from "./push";
import { pages, type SettingsPage } from "./settingsLogic";
import { can, Tile } from "./SettingsParts";
import { DeviceIcon, Dot, GitHubLogo, Icon, Mark, Row, Section, T, useColors } from "./ui";

const REPO = "https://github.com/ryan-stoffel/parallax";

function status(m: Computer): string {
  if (m.state.status === "connected") return `Connected · Parallax ${m.state.plxd}`;
  if (m.state.status === "failed") return m.state.error.message;
  return "Connecting…";
}

function StatusDot({ m }: { m: Computer }) {
  const c = useColors();
  return <Dot color={m.connected ? c.added : m.state.status === "connecting" ? c.warning : c.faintForeground} />;
}

/** "Parallax (Nightly) 1.2.3 (45)": this build's name and version. */
function versionName() {
  const { version, build } = appVersion();
  return `Parallax (Nightly) ${version}${build ? ` (${build})` : ""}`;
}

/** A small pill of a color, such as a computer's Default. */
function Pill({ label, color }: { label: string; color: string }) {
  return (
    <View style={[styles.pill, { backgroundColor: `${color}24` }]}>
      <T style={{ fontSize: 12, lineHeight: 16, fontWeight: "600", color }}>{label}</T>
    </View>
  );
}

/** The signed-in user's card at the top: their picture, name, and email, opening their account page. */
function ProfileCard() {
  const c = useColors();
  const { user } = useAccount();
  return (
    <Pressable
      accessibilityRole="button"
      accessibilityLabel="Your Parallax account"
      onPress={() => void Linking.openURL(`${PORTAL}/user`)}
      style={({ pressed }) => [
        styles.profile,
        { backgroundColor: pressed ? c.selected : c.surface, borderColor: c.border },
      ]}
    >
      <Avatar size={56} />
      <View style={{ flex: 1, gap: 2 }}>
        <T numberOfLines={1} style={{ fontSize: 18, lineHeight: 23, fontWeight: "600" }}>
          {nameOf(user) ?? "Parallax account"}
        </T>
        <T muted numberOfLines={1} style={{ fontSize: 14, lineHeight: 19 }}>
          {user?.email ?? "Your account, name, and picture"}
        </T>
      </View>
      <Icon icon={ChevronRight} size={16} color={c.faintForeground} />
    </Pressable>
  );
}

export function SettingsScreen() {
  const c = useColors();
  const nav = useNav();
  const prefs = usePrefs();
  const { computers, defaultId } = useFleet();
  const { accessToken, signOut } = useAccount();
  const [on, setOn] = useState<boolean>();
  const [relay, setRelay] = useState<string>();
  const [address, setAddress] = useState(() => tailnetAddress());

  const check = () => {
    setAddress(tailnetAddress());
    void notificationsOn().then(setOn);
  };
  useEffect(() => {
    check();
    void registerWithRelay(accessToken).then(setRelay);
    const sub = AppState.addEventListener("change", (s) => s === "active" && check());
    return () => sub.remove();
  }, []);

  const kind = (key: keyof Prefs["notify"], title: string, icon: LucideIcon, color: string) => (
    <Row
      leading={<Tile icon={icon} color={color} />}
      title={title}
      right={
        <Switch
          accessibilityLabel={title}
          value={prefs.notify[key]}
          disabled={!on}
          onValueChange={(v) => setPrefs({ notify: { ...prefs.notify, [key]: v } })}
        />
      }
    />
  );
  const look = (value: Prefs["appearance"], title: string, icon: LucideIcon, color: string, last = false) => (
    <Row
      leading={<Tile icon={icon} color={color} />}
      title={title}
      last={last}
      onPress={() => setPrefs({ appearance: value })}
      right={prefs.appearance === value ? <CircleCheck size={20} color={c.accent} /> : undefined}
    />
  );

  return (
    <ScrollView
      style={{ backgroundColor: c.background }}
      contentInsetAdjustmentBehavior="automatic"
      contentContainerStyle={{ paddingBottom: 40 }}
    >
      <View style={{ padding: 16, paddingTop: 8, gap: 28 }}>
        <ProfileCard />

        <Section
          title="Computers"
          footer="New threads start on the default computer. Your other computers with Parallax Connect on join on their own."
        >
          {computers.map((m) => (
            <Row
              key={m.machine.id}
              leading={
                <Tile color={c.projectSky}>
                  <DeviceIcon name={m.machine.name} size={17} color={c.projectSky} />
                </Tile>
              }
              title={m.machine.name}
              detail={status(m)}
              chevron
              onPress={() => nav.navigate("Computer", { id: m.machine.id })}
              right={
                <View style={styles.line}>
                  {m.machine.id === defaultId && <Pill label="Default" color={c.accent} />}
                  <StatusDot m={m} />
                </View>
              }
            />
          ))}
          <Row
            leading={<Tile icon={Plus} color={c.accent} />}
            title="Add computer"
            last
            onPress={() => nav.navigate("AddComputer")}
          />
        </Section>

        <Section footer="Cost, tokens, and limits on every computer.">
          <Row
            leading={<Tile icon={ChartColumn} color={c.projectGreen} />}
            title="Usage"
            chevron
            last
            onPress={() => nav.navigate("Usage")}
          />
        </Section>

        <Section
          title="Notifications"
          footer={
            on
              ? `When a thread needs your approval, finishes its turn, or fails, while Parallax is open or for about 30 seconds after you leave it. ${relay ?? "It also notifies while closed."}`
              : "Hear when a thread needs you, finishes, or fails."
          }
        >
          {!on ? (
            <Row
              leading={<Tile icon={BellOff} color={c.warning} />}
              title="Turn on notifications"
              chevron
              last
              onPress={() => void askForNotifications().then((ok) => (ok ? check() : Linking.openSettings()))}
            />
          ) : (
            <>
              {kind("needsYou", "Needs you", Hand, c.projectOrange)}
              {kind("done", "Finished", BellRing, c.projectGreen)}
              {kind("failed", "Failed", CircleX, c.projectRed)}
              <Row
                leading={<Tile icon={Send} color={c.accent} />}
                title="Send a test notification"
                last
                onPress={() => {
                  notify("done", "", "test", "Parallax", computers[0]?.machine.name ?? "this phone");
                  Alert.alert("Sent", "Leave the app within a few seconds to see it as a banner.");
                }}
              />
            </>
          )}
        </Section>

        <Section title="Appearance">
          {look("system", "Match the system", Smartphone, c.projectGray)}
          {look("light", "Light", Sun, c.projectYellow)}
          {look("dark", "Dark", Moon, c.projectViolet, true)}
        </Section>

        <Section
          title="Connection"
          footer={address ? `This phone is ${address} on your tailnet.` : "Open Tailscale to reach your computers."}
        >
          <Row
            leading={<Tile icon={Network} color={c.projectTeal} />}
            title="Tailscale"
            chevron={!address}
            last
            onPress={address ? undefined : () => void Linking.openURL("tailscale://").catch(() => {})}
            right={
              <View style={styles.line}>
                <T muted style={{ fontSize: 14 }}>
                  {address ? "Connected" : "Not connected"}
                </T>
                <Dot color={address ? c.added : c.faintForeground} />
              </View>
            }
          />
        </Section>

        <Section title="Account">
          <Row
            leading={<Tile icon={LockKeyhole} color={c.projectGray} />}
            title="Security and account deletion"
            chevron
            onPress={() => void Linking.openURL(`${PORTAL}/user/security`)}
          />
          <Row
            leading={<Tile icon={LogOut} color={c.danger} />}
            title="Sign out"
            destructive
            last
            onPress={() =>
              Alert.alert("Sign out of Parallax?", "Your computers stay on this phone.", [
                { text: "Cancel", style: "cancel" },
                { text: "Sign out", style: "destructive", onPress: () => void signOut() },
              ])
            }
          />
        </Section>

        <T faint style={styles.version}>
          {versionName()}
        </T>
      </View>
    </ScrollView>
  );
}

/** About, from the Settings sheet's info button: the version, and Parallax on GitHub. */
export function AboutScreen() {
  const c = useColors();
  return (
    <ScrollView
      style={{ backgroundColor: c.background }}
      contentInsetAdjustmentBehavior="automatic"
      contentContainerStyle={{ padding: 16, gap: 28, paddingBottom: 40 }}
    >
      <View style={{ alignItems: "center", gap: 10, paddingTop: 12 }}>
        <Mark size={64} />
        <T style={{ fontSize: 22, fontWeight: "600" }}>Parallax</T>
        <T muted style={{ textAlign: "center" }}>
          Every thread on every one of your computers, from your phone.
        </T>
      </View>
      <Section>
        <Row leading={<Tile icon={Info} color={c.projectGray} />} title="Version" detail={versionName()} last />
      </Section>
      <Section>
        <Row
          leading={
            <Tile color={c.foreground}>
              <GitHubLogo size={17} color={c.foreground} />
            </Tile>
          }
          title="Parallax on GitHub"
          detail="The source, releases, and roadmap."
          chevron
          onPress={() => void Linking.openURL(REPO)}
        />
        <Row
          leading={<Tile icon={Bug} color={c.projectRed} />}
          title="Report a problem"
          chevron
          last
          onPress={() => void Linking.openURL(`${REPO}/issues/new`)}
        />
      </Section>
    </ScrollView>
  );
}

/** Each of a computer's settings pages' icon and color. */
const pageIcons: Record<SettingsPage, [LucideIcon, keyof ReturnType<typeof useColors>]> = {
  providers: [Bot, "projectViolet"],
  accounts: [KeyRound, "projectYellow"],
  threads: [MessagesSquare, "accent"],
  schedules: [CalendarClock, "projectOrange"],
  sourceControl: [GitBranch, "projectPink"],
  computerUse: [MousePointerClick, "projectSky"],
  scripts: [SquareTerminal, "projectGray"],
  connections: [Network, "projectTeal"],
  storage: [HardDrive, "projectGreen"],
};

/** One computer: its status, version, address, its settings pages, and Make default, Reconnect, and Remove. */
export function ComputerScreen({ route, navigation }: NativeStackScreenProps<Screens, "Computer">) {
  const c = useColors();
  const m = useComputer(route.params.id);
  const { defaultId, setDefault, remove } = useFleet();
  useEffect(() => navigation.setOptions({ title: m?.machine.name ?? "Computer" }), [m?.machine.name]);
  if (!m) return null;
  const isDefault = m.machine.id === defaultId;
  return (
    <ScrollView
      style={{ backgroundColor: c.background }}
      contentInsetAdjustmentBehavior="automatic"
      contentContainerStyle={{ padding: 16, gap: 28, paddingBottom: 40 }}
    >
      <View style={{ alignItems: "center", gap: 8, paddingTop: 12 }}>
        <View style={[styles.hero, { backgroundColor: `${c.projectSky}24` }]}>
          <DeviceIcon name={m.machine.name} size={36} color={c.projectSky} />
        </View>
        <T style={{ fontSize: 20, fontWeight: "600" }}>{m.machine.name}</T>
        <View style={styles.line}>
          <StatusDot m={m} />
          <T muted>{m.connected ? "Connected" : m.state.status === "connecting" ? "Connecting…" : "Not reachable"}</T>
          {isDefault && <Pill label="Default" color={c.accent} />}
        </View>
      </View>
      <Section>
        {m.state.status === "connected" && <Row title="Parallax" detail={m.state.plxd} />}
        {m.state.status === "failed" && <Row title="Last error" detail={m.state.error.message} />}
        <Row title="System" detail={m.machine.os || "Unknown"} />
        <Row title={m.machine.paired ? "Paired on this Wi‑Fi" : "Tailscale address"} detail={m.machine.address} last />
      </Section>
      {m.connected && (
        <Section title="Settings" footer={`Saved on ${m.machine.name}, for every device that reaches it.`}>
          {(Object.keys(pages) as SettingsPage[])
            .filter((page) => page !== "computerUse" || can(m, "computerUse"))
            .map((page, i, all) => {
              const [icon, color] = pageIcons[page];
              return (
                <Row
                  key={page}
                  leading={<Tile icon={icon} color={c[color]} />}
                  title={pages[page]}
                  chevron
                  last={i === all.length - 1}
                  onPress={() => navigation.navigate("ComputerSettings", { id: m.machine.id, page })}
                />
              );
            })}
        </Section>
      )}
      <Section footer="New threads start on the default computer.">
        <Row
          leading={<Tile icon={Star} color={c.projectYellow} />}
          title={isDefault ? "Default computer" : "Make default"}
          onPress={isDefault ? undefined : () => setDefault(m.machine.id)}
          right={isDefault ? <CircleCheck size={20} color={c.accent} /> : undefined}
        />
        <Row
          leading={<Tile icon={RefreshCw} color={c.accent} />}
          title="Reconnect"
          onPress={() => void window.parallax.retry(m.machine.id)}
        />
        <Row
          leading={<Tile icon={Trash2} color={c.danger} />}
          title="Remove from this phone"
          destructive
          last
          onPress={() =>
            Alert.alert(`Remove ${m.machine.name}?`, "Its threads leave this phone. Add it again any time.", [
              { text: "Cancel", style: "cancel" },
              {
                text: "Remove",
                style: "destructive",
                onPress: () => {
                  remove(m.machine.id);
                  navigation.goBack();
                },
              },
            ])
          }
        />
      </Section>
      <T faint selectable style={styles.version}>
        {m.machine.id}
      </T>
    </ScrollView>
  );
}

export function AddComputerScreen({ navigation }: NativeStackScreenProps<Screens, "AddComputer">) {
  const { add } = useFleet();
  return (
    <FindComputers
      index={1}
      onFound={(found) => {
        add(found);
        navigation.goBack();
      }}
    />
  );
}

const styles = StyleSheet.create({
  profile: {
    flexDirection: "row",
    alignItems: "center",
    gap: 14,
    padding: 14,
    borderRadius: 18,
    borderCurve: "continuous",
    borderWidth: StyleSheet.hairlineWidth,
  },
  pill: { paddingHorizontal: 8, paddingVertical: 2, borderRadius: 999 },
  line: { flexDirection: "row", alignItems: "center", gap: 8 },
  hero: { width: 72, height: 72, borderRadius: 20, borderCurve: "continuous", alignItems: "center", justifyContent: "center" },
  version: { fontSize: 12, textAlign: "center" },
});
