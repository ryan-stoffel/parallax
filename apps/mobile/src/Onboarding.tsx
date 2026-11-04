// First run, after signing in to the Parallax account: the account's computers and where each
// stands, as this phone asks to use them on its own, so one Allow on another device connects them
// all (0091), or how to add one when there are none, then notifications. Nothing here needs a tap
// to connect. Settings › Add computer shows how to add one too.
import { useEffect, useRef, useState } from "react";
import { ActivityIndicator, AppState, Pressable, ScrollView, StyleSheet, View } from "react-native";

import { listHosts, type AccountHosts, type Gate, type Listed } from "./accountHosts";
import { allowThisPhone, enterSetupCode, formatCode } from "./accountPrompts";
import type { Saved } from "./host";
import { pairedId, withListed, type Machine, type Setup } from "./machines";
import { computerStatus, toAsk } from "./setup";
import { Pairing } from "./PairScreen";
import { askForNotifications } from "./push";
import { font } from "./theme";
import { BellRing } from "lucide-react-native";

import { Button, DeviceIcon, Dot, Icon, T, useColors } from "./ui";

const SCRIPTS = "https://raw.githubusercontent.com/ryan-stoffel/parallax/develop/scripts";
/**
 * The commands that add a computer to the account (0091 "Setup"), as the desktop's wizard shows
 * them, with nothing installed. The channel is nightly, as the phone's computers need a plxd newer
 * than the stable release. Windows Defender blocks other ways of running the script.
 */
const CONNECT_COMMANDS = [
  { os: "macOS or Linux", command: `curl -fsSL ${SCRIPTS}/connect.sh | sh -s -- --channel nightly` },
  { os: "Windows", command: `powershell -c "irm ${SCRIPTS}/connect.ps1 | iex; Connect-Parallax --channel nightly"` },
];

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
      {CONNECT_COMMANDS.map(({ os, command }) => (
        <View key={os} style={{ gap: 4 }}>
          <T muted style={{ fontSize: 14 }}>
            On {os}, run
          </T>
          <T selectable style={{ fontFamily: font.mono, fontSize: 13, color: c.foreground }}>
            {command}
          </T>
        </View>
      ))}
      <T muted style={{ fontSize: 14, lineHeight: 20 }}>
        It signs in to your Parallax account, then shows a 6-digit code to enter in Parallax.
      </T>
    </View>
  );
}

/** One of the account's computers and where it stands. There's nothing to do on it here. */
function ComputerRow({ listed, gate, stopped = false }: { listed: Listed; gate?: Gate; stopped?: boolean }) {
  const c = useColors();
  const status = computerStatus({
    ready: !gate,
    online: listed.online,
    stopped,
    ...(gate?.kind === "waiting" && { code: formatCode(gate.code) }),
  });
  return (
    <View style={[styles.choice, { borderColor: c.border, backgroundColor: c.surface }]}>
      <View style={[styles.symbol, { backgroundColor: c.selected }]}>
        <DeviceIcon name={listed.name} size={22} color={c.accent} />
      </View>
      <View style={{ flex: 1 }}>
        <T medium>{listed.name}</T>
        <T muted style={{ fontSize: 13 }}>
          {status}
        </T>
      </View>
      {!gate ? (
        <Dot color={c.added} size={10} />
      ) : (
        listed.online && !stopped && <ActivityIndicator color={c.faintForeground} />
      )}
    </View>
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
  const [stopped, setStopped] = useState(accounts?.askingStopped);
  const [unanswered, setUnanswered] = useState(false);
  const asking = useRef(false);
  const allowed = useRef(false);

  /** Asks on its own, once at a time, with no taps here. One Allow elsewhere covers them all. */
  const ask = async (found: Listed[]) => {
    const hosts = accounts ? toAsk(found, accounts.usesAny) : [];
    if (!accounts || !hosts.length || asking.current || accounts.askingStopped) return;
    asking.current = true;
    const asked = await allowThisPhone(accounts, hosts, (hostId, code) =>
      setGates((g) => ({ ...g, [hostId]: { kind: "waiting", code } })),
    );
    asking.current = false;
    setStopped(accounts.askingStopped);
    setUnanswered(asked === "unreachable");
    // The rest connect once this phone reaches its computers, which vouch for them.
    if (asked === "allowed") {
      allowed.current = true;
      setGates({});
    } else if (accounts.askingStopped)
      setGates((g) =>
        Object.fromEntries(Object.keys(g).map((id) => [id, { kind: "setup" as const }])),
      );
  };

  const look = async () => {
    const bearer = await token();
    const found = bearer ? await listHosts(bearer) : undefined;
    // Offline for now: what's showing stays, with any code, and the next look tries again.
    if (!found) return setListed((l) => l ?? []);
    setListed(found);
    void ask(found);
    setGates((g) =>
      Object.fromEntries(
        found
          .filter((l) => !allowed.current && !accounts?.usesAny && !accounts?.trusts(l.hostId))
          .map((l) => [l.hostId, l.online && g[l.hostId]?.kind === "waiting" ? g[l.hostId]! : { kind: "setup" as const }]),
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

  /** A denied or lapsed request ended it: this phone may ask again, as the user asked. */
  const askAgain = async () => {
    await accounts?.resumeAsking();
    setStopped(undefined);
    setUnanswered(false);
    void look();
  };

  /** A computer no other device uses yet takes the code its `plx connect` shows. */
  const enterCode = (computers: Listed[]) =>
    accounts &&
    enterSetupCode(accounts, computers, () => {
      allowed.current = true;
      setStopped(undefined);
      setUnanswered(false);
      setGates({});
    });

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
  const notReady = (listed ?? []).filter((l) => l.online && gates[l.hostId]);
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
              <ComputerRow key={l.hostId} listed={l} gate={gates[l.hostId]} stopped={!!stopped} />
            ))}
            {paired.map((m) => (
              <ComputerRow key={m.id} listed={{ hostId: m.id, name: m.name, online: true }} />
            ))}
            {!listed.length && !paired.length && <AddInstructions />}
            {waiting ? (
              <T muted style={{ fontSize: 14, lineHeight: 20 }}>
                Open Parallax on one of your computers and allow this iPhone. Both show{" "}
                {formatCode(waiting.code)}.
              </T>
            ) : stopped ? (
              <T muted style={{ fontSize: 14, lineHeight: 20 }}>
                {stopped}
              </T>
            ) : unanswered ? (
              <T muted style={{ fontSize: 14, lineHeight: 20 }}>
                Your computers aren't answering this iPhone yet. It keeps trying.
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
        {stopped && <Button label="Ask again" onPress={() => void askAgain()} />}
        <Button label="Continue" primary onPress={() => setStep("notify")} />
        {listed?.length === 0 && <Button label="Look again" onPress={() => void look()} />}
        {notReady.length > 0 && (
          <Pressable accessibilityRole="button" onPress={() => enterCode(notReady)} style={{ alignSelf: "center", padding: 10 }}>
            <T style={{ fontSize: 14, color: c.accent }}>Enter a code from plx connect</T>
          </Pressable>
        )}
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
