// The app: pairing until a computer is paired, then its threads, one thread, and settings. The
// connection, thread list, and transcripts are the desktop renderer's (host.ts).
import { reloadAppAsync } from "expo";
import { File, Paths } from "expo-file-system";
import { useEffect, useState } from "react";
import { Alert, AppState, ScrollView, StyleSheet, View } from "react-native";

import type { ConnectionState } from "../../desktop/src/preload/bridge";
import { useThreads } from "../../desktop/src/renderer/threads";
import { Account, AccountProvider, CLERK } from "./Account";
import { connect, forget, HOST, loadSaved, type Saved } from "./host";
import { Outbox, type Outgoing, type Sent } from "./outbox";
import { Pairing } from "./PairScreen";
import { registerForPush } from "./push";
import { ThreadScreen } from "./Thread";
import { ThreadList } from "./ThreadList";
import { Button, T, useColors } from "./ui";

const outboxFile = new File(Paths.document, "outbox.json");

function loadOutbox(): Outgoing[] {
  try {
    return outboxFile.exists ? (JSON.parse(outboxFile.textSync()) as Outgoing[]) : [];
  } catch {
    return [];
  }
}

/** The connection's state, for people, or undefined while connected. */
function describe(state: ConnectionState, name: string): string | undefined {
  if (state.status === "connected") return undefined;
  if (state.status === "connecting") return `Connecting to ${name}…`;
  return state.status === "failed"
    ? `${state.error.message} Trying again.`
    : `Not connected to ${name}.`;
}

/** Forgets the paired computer and starts the app over at pairing. */
const unpair = () => forget().then(() => reloadAppAsync());

function Connected({ saved }: { saved: Saved }) {
  const c = useColors();
  const [host] = useState(() => connect(saved, unpair));
  const [state, setState] = useState<ConnectionState>(host.state);
  const [openId, setOpenId] = useState<string>();
  const [settings, setSettings] = useState(false);
  const [push, setPush] = useState<string>();
  const connected = state.status === "connected";
  const view = useThreads(HOST, connected ? state.capabilities : undefined, undefined, () => {});

  const [outbox] = useState(() => {
    async function send(m: Outgoing): Promise<Sent> {
      if (host.state.status !== "connected") return "offline";
      const answer = await host.request("orchestration/dispatch", {
        type: "message.dispatch",
        threadId: m.threadId,
        messageId: m.id,
        commandId: m.id,
        text: m.text,
        dispatchMode: { type: m.steer ? "steer_active" : "queue_after_active" },
      });
      if (!("error" in answer)) return "sent";
      // The connection dropped or the answer was lost: it waits, and goes again with its id.
      if (host.state.status !== "connected" || answer.error.code === -32800) return "offline";
      return { error: answer.error };
    }
    const save = (messages: Outgoing[]) => outboxFile.write(JSON.stringify(messages));
    const refused = (m: Outgoing, error: { message: string }) =>
      Alert.alert("Message not sent", `“${m.text}”: ${error.message}`);
    return new Outbox(loadOutbox(), send, save, refused);
  });

  useEffect(() => {
    const listener = (_: string, next: ConnectionState) => setState(next);
    host.stateListeners.add(listener);
    // A phone that slept may have lost its socket: check it, or try again now.
    const awake = AppState.addEventListener("change", (s) => {
      if (s !== "active") return;
      host.heartbeat();
      host.retry();
    });
    void registerForPush(saved.fingerprint).then(setPush);
    return () => {
      host.stateListeners.delete(listener);
      awake.remove();
    };
  }, [host, saved.fingerprint]);

  useEffect(() => {
    if (connected) void outbox.drain();
  }, [connected, outbox]);

  const status = describe(state, saved.name);
  if (settings)
    return (
      <ScrollView
        style={{ backgroundColor: c.background }}
        contentContainerStyle={styles.settings}
        keyboardShouldPersistTaps="handled"
      >
        <Button label="Done" onPress={() => setSettings(false)} />
        <T medium style={{ fontSize: 20 }}>
          {saved.name}
        </T>
        <T muted>{status ?? "Connected"}</T>
        <T muted style={{ fontSize: 13 }}>
          {saved.routes.join(" · ")}
        </T>
        <T medium style={styles.heading}>
          Notifications
        </T>
        <T muted>{push ?? "On"}</T>
        {CLERK && (
          <>
            <T medium style={styles.heading}>
              Parallax account
            </T>
            <Account />
          </>
        )}
        <View style={{ marginTop: 24 }}>
          <Button label="Unpair this phone" onPress={() => void unpair()} />
        </View>
      </ScrollView>
    );
  const open = openId ? view.state.threads.find((t) => t.id === openId) : undefined;
  if (open)
    return (
      <ThreadScreen
        key={open.id}
        runId={open.id}
        title={view.state.titles[open.id] ?? "New thread"}
        connected={connected}
        outbox={outbox}
        onBack={() => setOpenId(undefined)}
      />
    );
  return (
    <ThreadList
      view={view}
      name={saved.name}
      status={status}
      onOpen={(t) => setOpenId(t.id)}
      onSettings={() => setSettings(true)}
    />
  );
}

export default function App() {
  const c = useColors();
  const [saved, setSaved] = useState<Saved | null>();
  useEffect(() => void loadSaved().then(setSaved), []);
  return (
    <AccountProvider>
      <View style={{ flex: 1, backgroundColor: c.background }}>
        {saved === null && <Pairing onPaired={setSaved} />}
        {saved && <Connected saved={saved} />}
      </View>
    </AccountProvider>
  );
}

const styles = StyleSheet.create({
  settings: { padding: 24, paddingTop: 72, gap: 8, alignItems: "stretch" },
  heading: { marginTop: 20 },
});
