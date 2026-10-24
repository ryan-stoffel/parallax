// First run, after sign-in: Tailscale on this phone, one of the user's computers to find the
// rest, the default computer for new threads, and notifications. "Add computer" in Settings
// runs the middle step again.
import { useEffect, useState } from "react";
import {
  ActivityIndicator,
  KeyboardAvoidingView,
  Linking,
  Pressable,
  ScrollView,
  StyleSheet,
  TextInput,
  View,
} from "react-native";

import { tailnetAddress } from "../modules/pinned-tls";
import type { Saved } from "./host";
import { probe, type Machine, type Setup } from "./machines";
import { Pairing } from "./PairScreen";
import { askForNotifications } from "./push";
import { font } from "./theme";
import { BellRing, Circle, CircleCheck, CircleArrowDown, SquareArrowOutUpRight } from "lucide-react-native";

import { Button, DeviceIcon, Dot, Icon, Mark, T, useColors } from "./ui";

const TAILSCALE_APP = "https://apps.apple.com/app/tailscale/id1470499037";

/** A LAN-paired computer as a machine (0065). */
export const pairedMachine = (saved: Saved): Machine => ({
  id: `paired-${saved.fingerprint.slice(0, 16)}`,
  name: saved.name,
  os: "",
  address: saved.routes[0] ?? "",
  paired: saved,
});

function Step({
  index,
  title,
  subtitle,
  children,
}: {
  index: number;
  title: string;
  subtitle: string;
  children: React.ReactNode;
}) {
  const c = useColors();
  return (
    <KeyboardAvoidingView behavior="padding" style={{ flex: 1, backgroundColor: c.background }}>
      <ScrollView contentContainerStyle={styles.page} keyboardShouldPersistTaps="handled">
        <View style={styles.progress}>
          {[0, 1, 2, 3].map((i) => (
            <View
              key={i}
              style={[styles.bar, { backgroundColor: i <= index ? c.accent : c.selected }]}
            />
          ))}
        </View>
        <View style={{ gap: 8, marginBottom: 8 }}>
          <T medium style={{ fontSize: 26, lineHeight: 34 }}>
            {title}
          </T>
          <T muted>{subtitle}</T>
        </View>
        {children}
      </ScrollView>
    </KeyboardAvoidingView>
  );
}

/** Finds the user's computers from any one of them. `onFound` gets every Parallax computer. */
export function FindComputers({
  onFound,
  index = 1,
}: {
  onFound: (machines: Machine[]) => void;
  index?: number;
}) {
  const c = useColors();
  const [address, setAddress] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string>();
  const [pairing, setPairing] = useState(false);

  async function find() {
    if (busy || !address.trim()) return;
    setBusy(true);
    setError(undefined);
    try {
      const found = await probe(address.trim());
      if (found.length) onFound(found);
      else setError("That computer answered, but lists no computer with Parallax Connect on.");
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setBusy(false);
    }
  }

  if (pairing) return <Pairing onPaired={(saved) => onFound([pairedMachine(saved)])} onCancel={() => setPairing(false)} />;
  return (
    <Step
      index={index}
      title="Find your computers"
      subtitle="Enter any computer that has Parallax with Connect on. Parallax finds the rest of your computers from it."
    >
      <TextInput
        accessibilityLabel="Computer name or address"
        placeholder="ryans-mac-mini or 100.64.0.1"
        placeholderTextColor={c.faintForeground}
        value={address}
        onChangeText={setAddress}
        autoCapitalize="none"
        autoCorrect={false}
        keyboardType="url"
        returnKeyType="search"
        onSubmitEditing={() => void find()}
        style={[styles.input, { color: c.foreground, borderColor: c.border, backgroundColor: c.surface }]}
      />
      <T faint style={{ fontSize: 13, lineHeight: 18 }}>
        Your computers' names are listed in the Tailscale app. On a computer, turn on Parallax
        Connect in Settings › Connections.
      </T>
      <Button
        label={busy ? "Looking…" : "Find computers"}
        primary
        disabled={busy || !address.trim()}
        onPress={() => void find()}
      />
      {error && (
        <T alert style={{ color: c.danger, fontSize: 14 }}>
          {error}
        </T>
      )}
      <Pressable
        accessibilityRole="button"
        onPress={() => setPairing(true)}
        style={{ alignSelf: "center", padding: 10 }}
      >
        <T style={{ fontSize: 14, color: c.accent }}>No Tailscale? Pair on this Wi‑Fi instead</T>
      </Pressable>
    </Step>
  );
}

/** A computer to pick, with its symbol and whether it's chosen. */
export function ComputerChoice({
  machine,
  chosen,
  onPress,
}: {
  machine: Machine;
  chosen: boolean;
  onPress: () => void;
}) {
  const c = useColors();
  return (
    <Pressable
      accessibilityRole="radio"
      accessibilityState={{ selected: chosen }}
      onPress={onPress}
      style={[
        styles.choice,
        { borderColor: chosen ? c.accent : c.border, backgroundColor: c.surface },
      ]}
    >
      <View style={[styles.symbol, { backgroundColor: c.selected }]}>
        <DeviceIcon name={machine.name} size={22} color={c.accent} />
      </View>
      <View style={{ flex: 1 }}>
        <T medium>{machine.name}</T>
        <T muted style={{ fontSize: 13 }}>
          {[machine.os, machine.address].filter(Boolean).join(" · ")}
        </T>
      </View>
      <Icon
        icon={chosen ? CircleCheck : Circle}
        size={22}
        color={chosen ? c.accent : c.faintForeground}
      />
    </Pressable>
  );
}

export function Onboarding({ onDone }: { onDone: (setup: Setup) => void }) {
  const c = useColors();
  const [step, setStep] = useState<"tailscale" | "find" | "default" | "notify">("tailscale");
  const [address, setAddress] = useState(() => tailnetAddress());
  const [machines, setMachines] = useState<Machine[]>([]);
  const [chosen, setChosen] = useState<string>();

  // Tailscale connects in its own app: check again while this step shows.
  useEffect(() => {
    if (step !== "tailscale") return;
    const timer = setInterval(() => setAddress(tailnetAddress()), 1500);
    return () => clearInterval(timer);
  }, [step]);

  if (step === "tailscale")
    return (
      <Step
        index={0}
        title="Connect with Tailscale"
        subtitle="Parallax reaches your computers over your own Tailscale network, encrypted end to end. Install Tailscale on this phone and sign in with the account your computers use."
      >
        <View style={[styles.status, { backgroundColor: c.surface, borderColor: c.border }]}>
          <Mark size={28} />
          <View style={{ flex: 1 }}>
            <T medium>{address ? "Tailscale is connected" : "Tailscale isn't connected"}</T>
            <T muted style={{ fontSize: 13 }}>
              {address ? `This phone is ${address}` : "Open Tailscale and turn it on."}
            </T>
          </View>
          <Dot color={address ? c.added : c.faintForeground} size={10} />
        </View>
        {!address && (
          <View style={{ flexDirection: "row", gap: 10 }}>
            <Button
              label="Get Tailscale"
              icon={CircleArrowDown}
              style={{ flex: 1 }}
              onPress={() => void Linking.openURL(TAILSCALE_APP)}
            />
            <Button
              label="Open Tailscale"
              icon={SquareArrowOutUpRight}
              style={{ flex: 1 }}
              onPress={() =>
                void Linking.openURL("tailscale://").catch(() => Linking.openURL(TAILSCALE_APP))
              }
            />
          </View>
        )}
        <Button label="Continue" primary onPress={() => setStep("find")} />
        {!address && (
          <T faint style={{ fontSize: 13, textAlign: "center" }}>
            You can continue without it to pair a computer on this Wi‑Fi.
          </T>
        )}
      </Step>
    );

  if (step === "find")
    return (
      <FindComputers
        onFound={(found) => {
          setMachines(found);
          setChosen(found[0]?.id);
          setStep("default");
        }}
      />
    );

  if (step === "default")
    return (
      <Step
        index={2}
        title="Choose your default computer"
        subtitle={`Found ${machines.length} computer${machines.length === 1 ? "" : "s"}. You'll see threads from all of them, and new threads start on this one.`}
      >
        <View style={{ gap: 10 }}>
          {machines.map((m) => (
            <ComputerChoice
              key={m.id}
              machine={m}
              chosen={chosen === m.id}
              onPress={() => setChosen(m.id)}
            />
          ))}
        </View>
        <Button label="Continue" primary disabled={!chosen} onPress={() => setStep("notify")} />
      </Step>
    );

  const finish = () => onDone({ machines, defaultId: chosen });
  return (
    <Step
      index={3}
      title="Stay in the loop"
      subtitle="Get a notification when a thread needs your approval, finishes, or fails, on any of your computers."
    >
      <View style={[styles.status, { backgroundColor: c.surface, borderColor: c.border }]}>
        <Icon icon={BellRing} size={24} color={c.accent} />
        <View style={{ flex: 1 }}>
          <T medium>mac-mini</T>
          <T muted style={{ fontSize: 13 }}>
            Fix the flaky checkout test · Needs your approval
          </T>
        </View>
      </View>
      <Button
        label="Turn on notifications"
        primary
        onPress={() => void askForNotifications().finally(finish)}
      />
      <Button label="Not now" onPress={finish} />
    </Step>
  );
}

export function Loading() {
  const c = useColors();
  return (
    <View style={{ flex: 1, alignItems: "center", justifyContent: "center", backgroundColor: c.background }}>
      <ActivityIndicator color={c.accent} />
    </View>
  );
}

const styles = StyleSheet.create({
  page: { padding: 24, paddingTop: 76, gap: 14, flexGrow: 1 },
  progress: { flexDirection: "row", gap: 6, marginBottom: 18 },
  bar: { flex: 1, height: 4, borderRadius: 2 },
  input: {
    borderWidth: 1,
    borderRadius: 12,
    paddingHorizontal: 14,
    paddingVertical: 13,
    fontFamily: font.regular,
    fontSize: 16,
  },
  status: {
    flexDirection: "row",
    alignItems: "center",
    gap: 14,
    borderWidth: 1,
    borderRadius: 16,
    padding: 16,
  },
  choice: {
    flexDirection: "row",
    alignItems: "center",
    gap: 12,
    borderWidth: 1.5,
    borderRadius: 16,
    padding: 12,
  },
  symbol: { width: 44, height: 44, borderRadius: 12, alignItems: "center", justifyContent: "center" },
});
