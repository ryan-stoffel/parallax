// Settings, a sheet from the sidebar's profile picture, laid out as the desktop's: the account's
// row, which opens Account (AccountScreen.tsx), then the desktop's sections with its plain icons,
// each a page pushed inside the sheet. General and Appearance are this phone's own: its
// notifications, by kind with a test, and its theme. The others are a computer's, with a picker
// for another (SettingsComputer.tsx), and Connections also has this phone's computers and
// Tailscale. About, from the sheet's info button, has the version and links. What the desktop's
// Settings keeps on the desktop itself, such as its browser, keybinds, window, fonts, editors,
// terminal, and updates, stays there.
import type { NativeStackScreenProps } from "@react-navigation/native-stack";
import {
  Bot,
  Bug,
  CalendarClock,
  ChartNoAxesColumn,
  ChevronRight,
  CircleCheck,
  GitBranch,
  HardDrive,
  Info,
  MessageSquare,
  Monitor,
  Moon,
  MousePointerClick,
  Palette,
  Plus,
  RefreshCw,
  Server,
  Settings as SettingsIcon,
  SquareTerminal,
  Star,
  Sun,
  Trash2,
  type LucideIcon,
} from "lucide-react-native";
import { useEffect, useState } from "react";
import { Alert, AppState, Linking, Pressable, ScrollView, StyleSheet, View } from "react-native";

import { appVersion, tailnetAddress } from "../modules/pinned-tls";
import { Avatar, nameOf, useAccount } from "./Account";
import { useComputer, useFleet, type Computer } from "./fleet";
import { useNav, type PhonePage, type SettingsScreens } from "./nav";
import { FindComputers } from "./Onboarding";
import { accessLevels } from "../../desktop/src/renderer/catalog";
import { allAccess } from "./offers";
import { setPrefs, usePrefs, type Prefs } from "./prefs";
import { askForNotifications, notificationsOn, notify, registerWithRelay } from "./push";
import { pages, type SettingsPage } from "./settingsLogic";
import { Action, can, Page, Section, SelectRow, SwitchRow } from "./SettingsParts";
import { DeviceIcon, Dot, GitHubLogo, Icon, Mark, Row, T, useColors } from "./ui";

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

/** The signed-in user's row at the top: their picture, name, and email, opening Account. */
function ProfileRow() {
  const c = useColors();
  const nav = useNav();
  const { user } = useAccount();
  return (
    <Pressable
      accessibilityRole="button"
      accessibilityLabel="Your Parallax account"
      onPress={() => nav.navigate("Account")}
      style={({ pressed }) => [
        styles.profile,
        { backgroundColor: pressed ? c.selected : c.surface, borderColor: c.border },
      ]}
    >
      <Avatar size={52} />
      <View style={{ flex: 1, gap: 2 }}>
        <T numberOfLines={1} style={{ fontSize: 17, lineHeight: 22, fontWeight: "600" }}>
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

/** This phone's own settings pages' titles. */
export const phonePages: Record<PhonePage, string> = { general: "General", appearance: "Appearance" };

/**
 * Settings' sections, in the desktop's order with its icons, but its Browser and Keybinds, which
 * are the desktop's own. Accounts and API keys are part of Providers, as on the desktop.
 */
const sections: [PhonePage | SettingsPage | "usage", LucideIcon][] = [
  ["general", SettingsIcon],
  ["threads", MessageSquare],
  ["appearance", Palette],
  ["providers", Bot],
  ["usage", ChartNoAxesColumn],
  ["schedules", CalendarClock],
  ["sourceControl", GitBranch],
  ["computerUse", MousePointerClick],
  ["scripts", SquareTerminal],
  ["connections", Server],
  ["storage", HardDrive],
];

/** Settings' first page: the account, then each section, which pushes its page inside the sheet. */
export function SettingsScreen() {
  const c = useColors();
  const nav = useNav();
  const { computers, defaultId } = useFleet();
  // A computer's sections open on the default computer, or the first.
  const id = defaultId ?? computers[0]?.machine.id ?? "";
  const open = (key: (typeof sections)[number][0]) => {
    if (key === "usage") nav.navigate("Usage");
    else if (key === "general" || key === "appearance") nav.navigate("PhoneSettings", { page: key });
    else nav.navigate("ComputerSettings", { id, page: key });
  };
  return (
    <ScrollView
      style={{ backgroundColor: c.background }}
      contentInsetAdjustmentBehavior="automatic"
      contentContainerStyle={{ padding: 16, paddingTop: 8, gap: 24, paddingBottom: 40 }}
    >
      <ProfileRow />
      <Section>
        {sections.map(([key, icon], i) => (
          <Row
            key={key}
            icon={icon}
            title={key === "usage" ? "Usage" : key === "general" || key === "appearance" ? phonePages[key] : pages[key]}
            chevron
            last={i === sections.length - 1}
            onPress={() => open(key)}
          />
        ))}
      </Section>
      <T faint style={styles.version}>
        {versionName()}
      </T>
    </ScrollView>
  );
}

/** General: this phone's notifications, by kind, with a test. */
function GeneralPage() {
  const prefs = usePrefs();
  const { computers } = useFleet();
  const { accessToken } = useAccount();
  const [on, setOn] = useState<boolean>();
  const [relay, setRelay] = useState<string>();

  const check = () => void notificationsOn().then(setOn);
  useEffect(() => {
    check();
    void registerWithRelay(accessToken).then(setRelay);
    const sub = AppState.addEventListener("change", (s) => s === "active" && check());
    return () => sub.remove();
  }, []);

  const kind = (key: keyof Prefs["notify"], title: string, detail: string) => (
    <SwitchRow
      title={title}
      detail={detail}
      value={prefs.notify[key]}
      disabled={!on}
      onChange={(v) => setPrefs({ notify: { ...prefs.notify, [key]: v } })}
    />
  );

  return (
    <Section
      title="Notifications"
      footer={
        on
          ? `When a thread needs your approval, finishes its turn, or fails, while Parallax is open or for about 30 seconds after you leave it. ${relay ?? "It also notifies while closed."}`
          : undefined
      }
    >
      {!on ? (
        <Row
          title="Turn on notifications"
          detail="Hear when a thread needs you, finishes, or fails."
          chevron
          last
          onPress={() => void askForNotifications().then((ok) => (ok ? check() : Linking.openSettings()))}
        />
      ) : (
        <>
          {kind("needsYou", "Needs you", "A thread asks for your approval or an answer.")}
          {kind("done", "Finished", "A thread finishes its turn.")}
          {kind("failed", "Failed", "A thread stops on an error.")}
          <Row
            title="Test notification"
            detail="Sends one, as a thread that finished would."
            last
            right={
              <Action
                label="Send"
                onPress={() => {
                  notify("done", "", "test", "Parallax", computers[0]?.machine.name ?? "this phone");
                  Alert.alert("Sent", "Leave the app within a few seconds to see it as a banner.");
                }}
              />
            }
          />
        </>
      )}
    </Section>
  );
}

/** Appearance: which theme this phone shows. */
function AppearancePage() {
  const prefs = usePrefs();
  return (
    <Section title="Theme">
      <SelectRow
        title="Color scheme"
        detail="Which theme shows. System follows your phone."
        value={prefs.appearance}
        options={[
          { value: "system", label: "System", icon: Monitor },
          { value: "light", label: "Light", icon: Sun },
          { value: "dark", label: "Dark", icon: Moon },
        ]}
        onChange={(appearance) => setPrefs({ appearance })}
        last
      />
    </Section>
  );
}

/** One of this phone's own settings pages. */
export function PhoneSettingsScreen({ route }: NativeStackScreenProps<SettingsScreens, "PhoneSettings">) {
  return <Page>{route.params.page === "general" ? <GeneralPage /> : <AppearancePage />}</Page>;
}

/** Threads' settings of this phone's own: the computer new threads start on, and their access. */
export function NewThreadsSection() {
  const { computers, defaultId, setDefault } = useFleet();
  const { access } = usePrefs();
  return (
    <Section title="New threads">
      <SelectRow
        title="Computer"
        detail="The computer a new thread starts on, while it's connected. New thread's picker can choose another."
        value={defaultId ?? ""}
        options={computers.map((m) => ({ value: m.machine.id, label: m.machine.name }))}
        onChange={setDefault}
      />
      <SelectRow
        title="Access"
        detail="What a new thread may do without asking. The prompt box's Access can change it for one thread."
        value={access ?? "default"}
        options={[
          { value: "default", label: "Provider's default" },
          ...allAccess.map((level) => ({
            value: level,
            label: accessLevels[level].label,
            description: accessLevels[level].description,
          })),
        ]}
        onChange={(value) => setPrefs({ access: value === "default" ? undefined : value })}
        last
      />
    </Section>
  );
}

/** Connections' settings of this phone's own: its computers, each with its page, Add computer, and Tailscale. */
export function PhoneConnections() {
  const c = useColors();
  const nav = useNav();
  const { computers, defaultId } = useFleet();
  const [address, setAddress] = useState(() => tailnetAddress());
  useEffect(() => {
    const sub = AppState.addEventListener("change", (s) => s === "active" && setAddress(tailnetAddress()));
    return () => sub.remove();
  }, []);
  return (
    <>
      <Section
        title="Computers"
        footer="New threads start on the default computer. Your other computers with Parallax Connect on join on their own."
      >
        {computers.map((m) => (
          <Row
            key={m.machine.id}
            leading={<DeviceIcon name={m.machine.name} size={18} color={c.mutedForeground} />}
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
        <Row icon={Plus} iconColor={c.accent} title="Add computer" last onPress={() => nav.navigate("AddComputer")} />
      </Section>
      <Section title="This phone">
        <Row
          title="Tailscale"
          detail={address ? `This phone is ${address} on your tailnet.` : "Open Tailscale to reach your computers."}
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
    </>
  );
}

/** About, from the Settings sheet's info button: the version, and Parallax on GitHub. */
export function AboutScreen() {
  const c = useColors();
  return (
    <ScrollView
      style={{ backgroundColor: c.background }}
      contentInsetAdjustmentBehavior="automatic"
      contentContainerStyle={{ padding: 16, gap: 24, paddingBottom: 40 }}
    >
      <View style={{ alignItems: "center", gap: 10, paddingTop: 12 }}>
        <Mark size={64} />
        <T style={{ fontSize: 22, fontWeight: "600" }}>Parallax</T>
        <T muted style={{ textAlign: "center" }}>
          Every thread on every one of your computers, from your phone.
        </T>
      </View>
      <Section>
        <Row icon={Info} title="Version" detail={versionName()} last />
      </Section>
      <Section>
        <Row
          leading={<GitHubLogo size={18} color={c.mutedForeground} />}
          title="Parallax on GitHub"
          detail="The source, releases, and roadmap."
          chevron
          onPress={() => void Linking.openURL(REPO)}
        />
        <Row icon={Bug} title="Report a problem" chevron last onPress={() => void Linking.openURL(`${REPO}/issues/new`)} />
      </Section>
    </ScrollView>
  );
}

/** Each of a computer's settings pages' icon, as the desktop's Settings has it. Accounts is part of Providers. */
const pageIcons: Partial<Record<SettingsPage, LucideIcon>> = {
  providers: Bot,
  threads: MessageSquare,
  schedules: CalendarClock,
  sourceControl: GitBranch,
  computerUse: MousePointerClick,
  scripts: SquareTerminal,
  connections: Server,
  storage: HardDrive,
};

/** One computer: its status, version, address, its settings pages, and Make default, Reconnect, and Remove. */
export function ComputerScreen({ route, navigation }: NativeStackScreenProps<SettingsScreens, "Computer">) {
  const c = useColors();
  const m = useComputer(route.params.id);
  const { defaultId, setDefault, remove } = useFleet();
  useEffect(() => navigation.setOptions({ title: m?.machine.name ?? "Computer" }), [m?.machine.name]);
  if (!m) return null;
  const isDefault = m.machine.id === defaultId;
  const shown = (Object.keys(pageIcons) as SettingsPage[]).filter((page) => page !== "computerUse" || can(m, "computerUse"));
  return (
    <ScrollView
      style={{ backgroundColor: c.background }}
      contentInsetAdjustmentBehavior="automatic"
      contentContainerStyle={{ padding: 16, gap: 24, paddingBottom: 40 }}
    >
      <View style={{ alignItems: "center", gap: 8, paddingTop: 12 }}>
        <DeviceIcon name={m.machine.name} size={44} color={c.mutedForeground} />
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
          {shown.map((page, i) => (
            <Row
              key={page}
              icon={pageIcons[page]}
              title={pages[page]}
              chevron
              last={i === shown.length - 1}
              onPress={() => navigation.navigate("ComputerSettings", { id: m.machine.id, page })}
            />
          ))}
        </Section>
      )}
      <Section footer="New threads start on the default computer.">
        <Row
          icon={Star}
          title={isDefault ? "Default computer" : "Make default"}
          onPress={isDefault ? undefined : () => setDefault(m.machine.id)}
          right={isDefault ? <CircleCheck size={20} color={c.accent} /> : undefined}
        />
        <Row icon={RefreshCw} title="Reconnect" onPress={() => void window.parallax.retry(m.machine.id)} />
        <Row
          icon={Trash2}
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

export function AddComputerScreen({ navigation }: NativeStackScreenProps<SettingsScreens, "AddComputer">) {
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
    borderRadius: 14,
    borderCurve: "continuous",
    borderWidth: StyleSheet.hairlineWidth,
  },
  pill: { paddingHorizontal: 8, paddingVertical: 2, borderRadius: 999 },
  line: { flexDirection: "row", alignItems: "center", gap: 8 },
  version: { fontSize: 12, textAlign: "center" },
});
