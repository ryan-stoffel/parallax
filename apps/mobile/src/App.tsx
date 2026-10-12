// The app: pairing until a computer is paired, then its threads, one thread, and settings. The
// connection, thread list, and transcripts are the desktop renderer's (host.ts).
import { reloadAppAsync } from "expo";
import { Fragment, useEffect, useState } from "react";
import { Alert, AppState, ScrollView, StyleSheet, View } from "react-native";

import type { ConnectionState } from "../../desktop/src/preload/bridge";
import { useThreads } from "../../desktop/src/renderer/threads";
import { connect, forget, HOST, loadOutbox, loadSaved, saveOutbox, type Saved } from "./host";
import { Outbox, type Outgoing, type Sent } from "./outbox";
import { Pairing } from "./PairScreen";
import { registerForPush } from "./push";
import { ThreadScreen } from "./Thread";
import { ThreadList } from "./ThreadList";
import { Button, SwipeBack, T, useColors } from "./ui";

// Clerk's JS, about 1.6 MB of the bundle, only in a build with EXPO_PUBLIC_CLERK=1: a release
// build inlines the variable, and Metro folds the require away when it's off. Metro's cache doesn't
// key on it, so start Metro with --clear after changing it.
const account: typeof import("./Account") | undefined =
  process.env.EXPO_PUBLIC_CLERK === "1" ? require("./Account") : undefined;

/**
 * The connection's state, for people, or undefined while connected. A retry keeps showing why the
 * last try failed, such as another computer answering, rather than only "Connecting".
 */
function describe(state: ConnectionState, name: string, failed?: string): string | undefined {
  if (state.status === "connected") return undefined;
  if (failed) return `${failed} Trying again.`;
  return state.status === "connecting" ? `Connecting to ${name}…` : `Not connected to ${name}.`;
}

/** Forgets the paired computer and starts the app over at pairing. */
const unpair = () => forget().then(() => reloadAppAsync());

function Connected({ saved }: { saved: Saved }) {
  const c = useColors();
  const [host] = useState(() => connect(saved, unpair));
  const [state, setState] = useState<ConnectionState>(host.state);
  const [failed, setFailed] = useState<string>();
  const [openId, setOpenId] = useState<string>();
  const [settings, setSettings] = useState(false);
  const [push, setPush] = useState<string>();
  const [drafts] = useState(() => new Map<string, string>());
  const connected = state.status === "connected";
  const view = useThreads(HOST, connected ? state.capabilities : undefined, undefined, () => {});

  const [outbox] = useState(() => {
    const box: Outbox = new Outbox(loadOutbox(), send, saveOutbox, refused);
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
      // The connection dropped or the answer was lost: it waits, and goes again with its id, on
      // the next connection or, after a timeout, in a few seconds.
      if (host.state.status !== "connected") return "offline";
      if (answer.error.code === -32800) {
        setTimeout(() => void box.drain(), 5_000);
        return "offline";
      }
      return { error: answer.error };
    }
    function refused(m: Outgoing, error: { message: string }) {
      Alert.alert("Message not sent", `“${m.text}”: ${error.message}`);
    }
    return box;
  });

  useEffect(() => {
    const listener = (_: string, next: ConnectionState) => {
      setState(next);
      if (next.status === "failed") setFailed(next.error.message);
      if (next.status === "connected") setFailed(undefined);
    };
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

  const status = describe(state, saved.name, failed);
  if (settings)
    return (
      <SwipeBack onBack={() => setSettings(false)}>
        <ScrollView
          style={{ backgroundColor: c.background }}
          contentContainerStyle={styles.settings}
          keyboardShouldPersistTaps="handled"
          automaticallyAdjustKeyboardInsets
          keyboardDismissMode="interactive"
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
          {account && (
            <>
              <T medium style={styles.heading}>
                Parallax account
              </T>
              <account.Account />
            </>
          )}
          <View style={{ marginTop: 24 }}>
            <Button label="Unpair this phone" onPress={() => void unpair()} />
          </View>
        </ScrollView>
      </SwipeBack>
    );
  const open = openId ? view.state.threads.find((t) => t.id === openId) : undefined;
  if (open)
    return (
      <ThreadScreen
        key={open.id}
        runId={open.id}
        title={view.state.titles[open.id] ?? "New thread"}
        connected={connected}
        status={status}
        outbox={outbox}
        drafts={drafts}
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
  const [unreadable, setUnreadable] = useState<string>();
  const load = () => {
    setUnreadable(undefined);
    loadSaved().then(setSaved, (e: Error) => setUnreadable(e.message));
  };
  useEffect(load, []);
  const Provider = account?.AccountProvider ?? Fragment;
  return (
    <Provider>
      <View style={{ flex: 1, backgroundColor: c.background }}>
        {unreadable && (
          <View style={styles.settings}>
            <T alert style={{ color: c.danger }}>
              Parallax couldn't read this phone's Keychain: {unreadable}
            </T>
            <Button label="Try again" onPress={load} />
          </View>
        )}
        {saved === null && <Pairing onPaired={setSaved} />}
        {saved && <Connected saved={saved} />}
      </View>
    </Provider>
  );
}

const styles = StyleSheet.create({
  settings: { padding: 24, paddingTop: 72, gap: 8, alignItems: "stretch" },
  heading: { marginTop: 20 },
});
