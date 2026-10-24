// Settings, a sheet from the sidebar's profile picture: the account, the computers (each with its
// own page: status, default, reconnect, remove, and its settings, SettingsComputer.tsx), usage,
// notifications by kind with a test, appearance, and Tailscale. About, from the sheet's info
// button, has the version and links. What the desktop's Settings keeps on the desktop itself, such
// as its window, fonts, shortcuts, editors, terminal, and updates, stays there.
import type { NativeStackScreenProps } from "@react-navigation/native-stack";
import {
  BellOff,
  Bot,
  Bug,
  CalendarClock,
  ChartColumn,
  CircleCheck,
  GitBranch,
  HardDrive,
  Info,
  KeyRound,
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
import { Alert, AppState, Linking, Pressable, ScrollView, Switch, View } from "react-native";

import { appVersion, tailnetAddress } from "../modules/pinned-tls";
import { AccountSection, Avatar, nameOf, useAccount } from "./Account";
import { useComputer, useFleet, type Computer } from "./fleet";
import { useNav, type Screens } from "./nav";
import { FindComputers } from "./Onboarding";
import { setPrefs, usePrefs, type Prefs } from "./prefs";
import { askForNotifications, notificationsOn, notify, registerWithRelay } from "./push";
import { pages, type SettingsPage } from "./settingsLogic";
import { can } from "./SettingsParts";
import { DeviceIcon, Dot, GitHubLogo, Mark, Row, Section, T, useColors } from "./ui";

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

/** The signed-in user's card: their picture, name, and email. */
function Profile() {
  const { user } = useAccount();
  return (
    <View style={{ alignItems: "center", gap: 10, paddingTop: 4 }}>
      <Avatar size={72} />
      <View style={{ alignItems: "center", gap: 2 }}>
        <T style={{ fontSize: 22, fontWeight: "600" }}>{nameOf(user) ?? "Parallax account"}</T>
        {!!user?.email && <T muted>{user.email}</T>}
      </View>
    </View>
  );
}

export function SettingsScreen() {
  const c = useColors();
  const nav = useNav();
  const prefs = usePrefs();
  const { computers, defaultId } = useFleet();
  const { accessToken } = useAccount();
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

  const kind = (key: keyof Prefs["notify"], title: string, detail: string, last = false) => (
    <Row
      title={title}
      detail={detail}
      last={last}
      right={
        <Switch
          value={prefs.notify[key]}
          disabled={!on}
          onValueChange={(v) => setPrefs({ notify: { ...prefs.notify, [key]: v } })}
        />
      }
    />
  );
  const look = (value: Prefs["appearance"], title: string, icon: typeof Sun, last = false) => (
    <Row
      icon={icon}
      title={title}
      last={last}
      onPress={() => setPrefs({ appearance: value })}
      right={prefs.appearance === value ? <CircleCheck size={18} color={c.accent} /> : undefined}
    />
  );

  return (
    <ScrollView
      style={{ backgroundColor: c.background }}
      contentInsetAdjustmentBehavior="automatic"
      contentContainerStyle={{ paddingBottom: 60 }}
    >
      <View style={{ padding: 16, paddingTop: 12, gap: 26 }}>
        <Profile />

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
                <View style={{ flexDirection: "row", alignItems: "center", gap: 8 }}>
                  {m.machine.id === defaultId && <T style={{ fontSize: 12, color: c.accent }}>Default</T>}
                  <StatusDot m={m} />
                </View>
              }
            />
          ))}
          <Row icon={Plus} iconColor={c.accent} title="Add computer" last onPress={() => nav.navigate("AddComputer")} />
        </Section>

        <Section>
          <Row
            icon={ChartColumn}
            title="Usage"
            detail="Cost, tokens, and limits on every computer."
            chevron
            last
            onPress={() => nav.navigate("Usage")}
          />
        </Section>

        <Section
          title="Notifications"
          footer={
            on
              ? `While Parallax is open, or for about 30 seconds after you leave it. ${relay ?? "It also notifies while closed."}`
              : undefined
          }
        >
          {!on ? (
            <Row
              icon={BellOff}
              title="Turn on notifications"
              detail="Hear when a thread needs you, finishes, or fails."
              chevron
              last
              onPress={() => void askForNotifications().then((ok) => (ok ? check() : Linking.openSettings()))}
            />
          ) : (
            <>
              {kind("needsYou", "Needs you", "A thread asks for your approval.")}
              {kind("done", "Finished", "A thread's turn is done.")}
              {kind("failed", "Failed", "A thread's turn failed.")}
              <Row
                icon={Send}
                iconColor={c.accent}
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
          {look("system", "Match the system", Smartphone)}
          {look("light", "Light", Sun)}
          {look("dark", "Dark", Moon, true)}
        </Section>

        <Section title="Tailscale">
          <Row
            icon={Network}
            title={address ? "Connected" : "Not connected"}
            detail={address ? `This phone is ${address}` : "Open Tailscale to reach your computers."}
            right={<Dot color={address ? c.added : c.faintForeground} />}
            last
            onPress={address ? undefined : () => void Linking.openURL("tailscale://").catch(() => {})}
          />
        </Section>

        <AccountSection />
      </View>
    </ScrollView>
  );
}

/** About, from the Settings sheet's info button: the version, and Parallax on GitHub. */
export function AboutScreen() {
  const c = useColors();
  const { version, build } = appVersion();
  return (
    <ScrollView
      style={{ backgroundColor: c.background }}
      contentInsetAdjustmentBehavior="automatic"
      contentContainerStyle={{ padding: 16, gap: 26, paddingBottom: 60 }}
    >
      <View style={{ alignItems: "center", gap: 10, paddingTop: 12 }}>
        <Mark size={64} />
        <T style={{ fontSize: 22, fontWeight: "600" }}>Parallax</T>
        <T muted style={{ textAlign: "center" }}>
          Every thread on every one of your computers, from your phone.
        </T>
      </View>
      <Section>
        <Row icon={Info} title="Version" detail={`Parallax (Nightly) ${version}${build ? ` (${build})` : ""}`} last />
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

/** Each of a computer's settings pages' icon. */
const pageIcons: Record<SettingsPage, LucideIcon> = {
  providers: Bot,
  accounts: KeyRound,
  threads: MessagesSquare,
  schedules: CalendarClock,
  sourceControl: GitBranch,
  computerUse: MousePointerClick,
  scripts: SquareTerminal,
  connections: Network,
  storage: HardDrive,
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
    <ScrollView style={{ backgroundColor: c.background }} contentContainerStyle={{ padding: 16, gap: 24 }}>
      <View style={{ alignItems: "center", gap: 8, paddingTop: 12 }}>
        <DeviceIcon name={m.machine.name} size={44} color={c.accent} />
        <T style={{ fontSize: 20, fontWeight: "600" }}>{m.machine.name}</T>
        <View style={{ flexDirection: "row", alignItems: "center", gap: 6 }}>
          <StatusDot m={m} />
          <T muted>{m.connected ? "Connected" : m.state.status === "connecting" ? "Connecting…" : "Not reachable"}</T>
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
            .map((page, i, all) => (
              <Row
                key={page}
                icon={pageIcons[page]}
                title={pages[page]}
                chevron
                last={i === all.length - 1}
                onPress={() => navigation.navigate("ComputerSettings", { id: m.machine.id, page })}
              />
            ))}
        </Section>
      )}
      <Section>
        <Row
          icon={Star}
          iconColor={isDefault ? c.accent : undefined}
          title={isDefault ? "Default computer" : "Make default"}
          detail="New threads start here."
          onPress={isDefault ? undefined : () => setDefault(m.machine.id)}
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
      <Pressable onPress={() => navigation.goBack()} style={{ alignSelf: "center", padding: 8 }}>
        <T faint style={{ fontSize: 13 }}>
          {m.machine.id}
        </T>
      </Pressable>
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

