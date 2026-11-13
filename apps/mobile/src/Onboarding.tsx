// First run, after signing in to the Parallax account: the account's computers and where each
// stands, as this phone asks to use them on its own, so one Allow on another device connects them
// all (0091), or how to add one when there are none, then notifications. Nothing here needs a tap
// to connect. Settings › Add computer shows how to add one too.
import { t } from "i18next";
import { useEffect, useRef, useState } from "react";
import { ActivityIndicator, AppState, Pressable, ScrollView, StyleSheet, View } from "react-native";

import { listHosts, type AccountHosts, type Gate, type Listed } from "./accountHosts";
import { allowThisPhone, enterSetupCode, formatCode, showWaiting } from "./accountPrompts";
import type { Saved } from "./host";
import { pairedId, withListed, type Machine, type Setup } from "./machines";
import { computerStatus, toAsk } from "./setup";
import { Pairing } from "./PairScreen";
import { PHONE } from "./phone";
import { askForNotifications } from "./push";
import { font } from "./theme";
import { BellRing } from "lucide-react-native";

import { Button, DeviceIcon, Dot, Icon, T, useColors } from "./ui";

const SCRIPTS = "https://raw.githubusercontent.com/ryan-stoffel/parallax/develop/scripts";
/**
 * The commands that add a computer to the account (0091 "Setup"), as the desktop's wizard shows
 * them, with nothing installed. Nightly, until a stable release has this flow (0091). Windows
 * Defender blocks other ways of running the script. `device` is this phone's key, which reaches the
 * new computer only through the user, so that computer can take this phone's Allow alone. A key
 * can start with `-`, so it's one `--device=`.
 */
const connectCommands = (device?: string) => {
  const flags = `--channel nightly${device ? ` --device=${device}` : ""}`;
  return [
    { os: t("macOS or Linux"), command: `curl -fsSL ${SCRIPTS}/connect.sh | sh -s -- ${flags}` },
    { os: "Windows", command: `powershell -c "irm ${SCRIPTS}/connect.ps1 | iex; Connect-Parallax ${flags}"` },
  ];
};

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
export function AddInstructions({ device }: { device?: string }) {
  const c = useColors();
  return (
    <View style={[styles.card, { backgroundColor: c.surface, borderColor: c.border }]}>
      {connectCommands(device).map(({ os, command }) => (
        <View key={os} style={{ gap: 4 }}>
          <T muted style={{ fontSize: 14 }}>
            {t("On {{os}}, run", { os })}
          </T>
          <T selectable style={{ fontFamily: font.mono, fontSize: 13, color: c.foreground }}>
            {command}
          </T>
        </View>
      ))}
      <T muted style={{ fontSize: 14, lineHeight: 20 }}>
        {t("It signs in to your Parallax account, then shows a 6-digit code. Parallax here shows the same one to allow.")}
      </T>
    </View>
  );
}

/** One of the account's computers and where it stands. There's nothing to do on it here. */
function ComputerRow({
  listed,
  gate,
  stopped = false,
  usesAny = false,
}: {
  listed: Listed;
  gate?: Gate;
  stopped?: boolean;
  usesAny?: boolean;
}) {
  const c = useColors();
  const status = computerStatus({
    ready: !gate,
    online: listed.online,
    stopped,
    usesAny,
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
        listed.online && !stopped && (!usesAny || gate.kind === "waiting") && <ActivityIndicator color={c.faintForeground} />
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
  const shownCode = useRef<string | undefined>(undefined);
  const allowed = useRef(false);
  /** A typed code is running, or let this phone in: an answer to its request is no Allow then. */
  const typed = useRef(false);

  /** Asks on its own, once at a time, with no taps here. One Allow elsewhere covers them all. */
  const ask = async (found: Listed[]) => {
    const hosts = accounts ? toAsk(found, accounts.usesAny) : [];
    if (!accounts || !hosts.length || asking.current || accounts.askingStopped) return;
    asking.current = true;
    const asked = await allowThisPhone(accounts, hosts, (hostId, code, allow) => {
      setGates((g) => ({ ...g, [hostId]: { kind: "waiting", code } }));
      if (shownCode.current === code) return;
      shownCode.current = code;
      showWaiting(hosts.find((h) => h.hostId === hostId)?.name ?? t("your computers"), code, allow);
    });
    asking.current = false;
    setStopped(accounts.askingStopped);
    setUnanswered(asked === "unreachable");
    // The rest connect once this phone reaches its computers, which vouch for them.
    if (asked === "allowed" && !typed.current) {
      allowed.current = true;
      setGates({});
    } else if (accounts.askingStopped || accounts.usesAny)
      // No request is waiting now, and a typed code covers only its own computer.
      setGates((g) =>
        Object.fromEntries(
          Object.keys(g)
            .filter((id) => !accounts.trusts(id))
            .map((id) => [id, { kind: "setup" as const }]),
        ),
      );
  };

  const look = async () => {
    const bearer = await token();
    const found = bearer ? (await listHosts(bearer))?.hosts : undefined;
    // Offline for now: what's showing stays, with any code, and the next look tries again.
    if (!found) return setListed((l) => l ?? []);
    setListed(found);
    void ask(found);
    setGates((g) =>
      Object.fromEntries(
        found
          .filter((l) => !allowed.current && !accounts?.trusts(l.hostId))
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

  /**
   * A computer no other device uses yet takes the code its `plx connect` shows. That covers only
   * that one, so another new computer here can take its own.
   */
  const enterCode = (computers: Listed[]) =>
    accounts &&
    enterSetupCode(accounts, computers, {
      started: () => {
        typed.current = true;
      },
      ended: () => {
        typed.current = !!accounts.usesAny;
      },
      done: (hostId) => {
        setStopped(undefined);
        setUnanswered(false);
        setGates(({ [hostId]: _, ...rest }) => rest);
      },
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
        title={t("Your computers")}
        subtitle={t("The computers on your Parallax account. Allow this {{device}} once on one of them, and they all connect.", { device: PHONE })}
      >
        {!listed ? (
          <ActivityIndicator color={c.accent} style={{ marginVertical: 24 }} />
        ) : (
          <View style={{ gap: 10 }}>
            {listed.map((l) => (
              <ComputerRow
                key={l.hostId}
                listed={l}
                gate={gates[l.hostId]}
                stopped={!!stopped || !accounts}
                usesAny={!!accounts?.usesAny}
              />
            ))}
            {paired.map((m) => (
              <ComputerRow key={m.id} listed={{ hostId: m.id, name: m.name, online: true }} />
            ))}
            {!listed.length && !paired.length && <AddInstructions device={accounts?.thumbprint} />}
            {waiting ? (
              <T muted style={{ fontSize: 14, lineHeight: 20 }}>
                {t("Open Parallax on one of your computers and allow this {{device}}. Both show {{code}}.", { device: PHONE, code: formatCode(waiting.code) })}
              </T>
            ) : !accounts ? (
              <T muted style={{ fontSize: 14, lineHeight: 20 }}>
                {t("Parallax couldn't read what this {{device}} saved. Close the app and open it again.", { device: PHONE })}
              </T>
            ) : stopped ? (
              <T muted style={{ fontSize: 14, lineHeight: 20 }}>
                {stopped}
              </T>
            ) : unanswered ? (
              <T muted style={{ fontSize: 14, lineHeight: 20 }}>
                {t("Your computers aren't answering this {{device}} yet. It keeps trying.", { device: PHONE })}
              </T>
            ) : (
              listed.length > 0 &&
              !listed.some((l) => l.online) &&
              !accounts?.usesAny && (
                <T muted style={{ fontSize: 14, lineHeight: 20 }}>
                  {t("None of your computers are online. Turn one on, and this {{device}} asks it by itself.", { device: PHONE })}
                </T>
              )
            )}
          </View>
        )}
        {stopped && <Button label={t("Ask again")} onPress={() => void askAgain()} />}
        <Button label={t("Continue")} primary onPress={() => setStep("notify")} />
        {listed?.length === 0 && <Button label={t("Look again")} onPress={() => void look()} />}
        {accounts && notReady.length > 0 && (
          <Pressable accessibilityRole="button" onPress={() => enterCode(notReady)} style={{ alignSelf: "center", padding: 10 }}>
            <T style={{ fontSize: 14, color: c.accent }}>{t("Enter a code from plx connect")}</T>
          </Pressable>
        )}
        <Pressable accessibilityRole="button" onPress={() => setStep("pair")} style={{ alignSelf: "center", padding: 10 }}>
          <T style={{ fontSize: 14, color: c.accent }}>{t("Pair a computer on this Wi‑Fi instead")}</T>
        </Pressable>
      </Step>
    );

  const finish = () =>
    onDone({ machines: [...withListed([], listed ?? []), ...paired], onboarded: true });
  return (
    <Step
      index={1}
      title={t("Stay in the loop")}
      subtitle={t("Get a notification when a thread needs your approval, finishes, or fails, on any of your computers.")}
    >
      <View style={[styles.status, { backgroundColor: c.surface, borderColor: c.border }]}>
        <Icon icon={BellRing} size={24} color={c.accent} />
        <View style={{ flex: 1 }}>
          <T medium>mac-mini</T>
          <T muted style={{ fontSize: 13 }}>
            {t("Fix the flaky checkout test · Needs your approval")}
          </T>
        </View>
      </View>
      <Button
        label={t("Turn on notifications")}
        primary
        onPress={() => void askForNotifications().finally(finish)}
      />
      <Button label={t("Not now")} onPress={finish} />
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
