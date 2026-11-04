// First run, after signing in to the Parallax account: the account's computers, which this phone
// asks to use on its own, so one Allow on another device connects them all (0091), or how to add
// one when there are none, then notifications. Settings › Add computer shows how to add one too.
import { useEffect, useRef, useState } from "react";
import { ActivityIndicator, AppState, Pressable, ScrollView, StyleSheet, View } from "react-native";

import { listHosts, type AccountHosts, type Gate, type Listed } from "./accountHosts";
import { allowThisPhone, formatCode, setUpComputer } from "./accountPrompts";
import type { Saved } from "./host";
import { pairedId, withListed, type Machine, type Setup } from "./machines";
import { toAsk } from "./setup";
import { Pairing } from "./PairScreen";
import { askForNotifications } from "./push";
import { font } from "./theme";
import { BellRing, ChevronRight } from "lucide-react-native";

import { Button, DeviceIcon, Dot, Icon, T, useColors } from "./ui";

/** The command that adds a computer to the account (0091 "Setup"). */
export const CONNECT_COMMAND = "npx -y plx-cli@latest connect";

/** How often this looks for the account's computers while it's open. */
const LOOK_MS = 15_000;

/** A LAN-paired computer as a machine (0065). */
const pairedMachine = (saved: Saved): Machine => ({ id: pairedId(saved), name: saved.name, paired: saved });

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
    // The scroll view is the root, which a sheet (Settings › Add computer) needs to size it.
    <ScrollView style={{ flex: 1, backgroundColor: c.background }} contentContainerStyle={styles.page}>
      <View style={styles.progress}>
        {[0, 1].map((i) => (
          <View key={i} style={[styles.bar, { backgroundColor: i <= index ? c.accent : c.selected }]} />
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
  );
}

/** How to add a computer to the account: the command to run on it, and what follows. */
export function AddInstructions() {
  const c = useColors();
  return (
    <View style={[styles.card, { backgroundColor: c.surface, borderColor: c.border }]}>
      <T muted style={{ fontSize: 14 }}>
        On the computer, run
      </T>
      <T selectable style={{ fontFamily: font.mono, fontSize: 15, color: c.foreground }}>
        {CONNECT_COMMAND}
      </T>
      <T muted style={{ fontSize: 14, lineHeight: 20 }}>
        On Windows, use npx.cmd. It signs in to your Parallax account, then shows a 6-digit code. Tap
        the computer here and type the code.
      </T>
    </View>
  );
}

/** One of the account's computers, with whether it's ready, and set up on a tap when it isn't. */
function ComputerRow({ listed, gate, onPress }: { listed: Listed; gate?: Gate; onPress: () => void }) {
  const c = useColors();
  const status = !gate
    ? "Ready"
    : gate.kind === "waiting"
      ? `Waiting for approval · ${formatCode(gate.code)}`
      : listed.online
        ? "Tap to set up"
        : "Offline · Set up when it's on";
  return (
    <Pressable
      accessibilityRole="button"
      onPress={onPress}
      disabled={!gate}
      style={[styles.choice, { borderColor: c.border, backgroundColor: c.surface }]}
    >
      <View style={[styles.symbol, { backgroundColor: c.selected }]}>
        <DeviceIcon name={listed.name} size={22} color={c.accent} />
      </View>
      <View style={{ flex: 1 }}>
        <T medium>{listed.name}</T>
        <T muted style={{ fontSize: 13 }}>
          {status}
        </T>
      </View>
      {gate ? (
        <Icon icon={ChevronRight} size={18} color={c.faintForeground} />
      ) : (
        <Dot color={c.added} size={10} />
      )}
    </Pressable>
  );
}

export function Onboarding({
  accounts,
  token,
  onDone,
}: {
  /** The account's computers' sessions and approvals, unless they couldn't be read. */
  accounts?: AccountHosts;
  token: () => Promise<string | undefined>;
  onDone: (setup: Setup) => void;
}) {
  const c = useColors();
  const [step, setStep] = useState<"computers" | "pair" | "notify">("computers");
  const [listed, setListed] = useState<Listed[]>();
  const [paired, setPaired] = useState<Machine[]>([]);
  const [gates, setGates] = useState<Record<string, Gate>>({});
  // Why a request ended, until the user starts another. Set, this phone doesn't ask on its own.
  const [stopped, setStopped] = useState<string>();
  const asking = useRef(false);
  const stoppedRef = useRef(false);
  const allowed = useRef(false);

  /** Asks on its own, once at a time, with no taps here. One Allow elsewhere covers them all. */
  const ask = async (found: Listed[]) => {
    const hosts = accounts ? toAsk(found, accounts.usesAny) : [];
    if (!accounts || !hosts.length || asking.current || stoppedRef.current) return;
    asking.current = true;
    const asked = await allowThisPhone(
      accounts,
      hosts,
      (hostId, code) => setGates((g) => ({ ...g, [hostId]: { kind: "waiting", code } })),
      (message) => {
        stoppedRef.current = true;
        setStopped(message);
      },
    );
    asking.current = false;
    // The rest connect once this phone reaches its computers, which vouch for them.
    if (asked === "allowed") {
      allowed.current = true;
      setGates({});
    } else
      setGates((g) =>
        Object.fromEntries(Object.keys(g).map((id) => [id, { kind: "setup" as const }])),
      );
  };

  const look = async () => {
    const bearer = await token();
    const found = (bearer && (await listHosts(bearer))) || [];
    setListed(found);
    void ask(found);
    setGates((g) =>
      Object.fromEntries(
        found
          .filter((l) => !allowed.current && !accounts?.trusts(l.hostId))
          .map((l) => [l.hostId, g[l.hostId]?.kind === "waiting" ? g[l.hostId]! : { kind: "setup" as const }]),
      ),
    );
  };
  // Lists them now, and again on coming back from the computer that ran `plx connect`.
  useEffect(() => {
    void look();
    const sub = AppState.addEventListener("change", (s) => s === "active" && void look());
    // A computer that comes online here gets asked, with nothing to tap.
    const timer = setInterval(() => void look(), LOOK_MS);
    return () => {
      sub.remove();
      clearInterval(timer);
    };
  }, []);

  const setUp = (l: Listed) => {
    if (!accounts) return;
    const ready = () => {
      allowed.current = true;
      setStopped(undefined);
      setGates({});
    };
    setUpComputer(accounts, { hostId: l.hostId, name: l.name, routes: [] }, {
      onWaiting: (code) => setGates((g) => ({ ...g, [l.hostId]: { kind: "waiting", code } })),
      done: ready,
      failed: () => setGates((g) => ({ ...g, [l.hostId]: { kind: "setup" } })),
    });
  };

  if (step === "pair")
    return (
      <Pairing
        onPaired={(saved) => {
          setPaired([pairedMachine(saved)]);
          setStep("computers");
        }}
        onCancel={() => setStep("computers")}
      />
    );

  const waiting = Object.values(gates).find((g) => g.kind === "waiting") as
    | Extract<Gate, { kind: "waiting" }>
    | undefined;
  if (step === "computers")
    return (
      <Step
        index={0}
        title="Your computers"
        subtitle="The computers on your Parallax account. Allow this iPhone once on one of them, and they all connect."
      >
        {!listed ? (
          <ActivityIndicator color={c.accent} style={{ marginVertical: 24 }} />
        ) : (
          <View style={{ gap: 10 }}>
            {listed.map((l) => (
              <ComputerRow key={l.hostId} listed={l} gate={gates[l.hostId]} onPress={() => setUp(l)} />
            ))}
            {paired.map((m) => (
              <ComputerRow key={m.id} listed={{ hostId: m.id, name: m.name, online: true }} onPress={() => {}} />
            ))}
            {!listed.length && !paired.length && <AddInstructions />}
            {waiting ? (
              <T muted style={{ fontSize: 14, lineHeight: 20 }}>
                Open Parallax on one of your computers and allow this iPhone. Both show{" "}
                {formatCode(waiting.code)}. A computer that's new can take the code it shows instead:
                tap it.
              </T>
            ) : stopped ? (
              <T muted style={{ fontSize: 14, lineHeight: 20 }}>
                {stopped} Tap a computer to ask again.
              </T>
            ) : (
              listed.length > 0 &&
              !listed.some((l) => l.online) &&
              !accounts?.usesAny && (
                <T muted style={{ fontSize: 14, lineHeight: 20 }}>
                  None of your computers are online. Turn one on, and this iPhone asks it by itself.
                </T>
              )
            )}
          </View>
        )}
        <Button label="Continue" primary onPress={() => setStep("notify")} />
        {listed?.length === 0 && <Button label="Look again" onPress={() => void look()} />}
        <Pressable accessibilityRole="button" onPress={() => setStep("pair")} style={{ alignSelf: "center", padding: 10 }}>
          <T style={{ fontSize: 14, color: c.accent }}>Pair a computer on this Wi‑Fi instead</T>
        </Pressable>
      </Step>
    );

  const finish = () =>
    onDone({ machines: [...withListed([], listed ?? []), ...paired], onboarded: true });
  return (
    <Step
      index={1}
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
  card: { borderWidth: 1, borderRadius: 16, padding: 16, gap: 8 },
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
