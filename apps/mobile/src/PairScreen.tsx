// Pairing (0065): pick a computer showing a code on this network, or type its address, then the
// code from its Settings > Connections > Pair a device.
import { useEffect, useState } from "react";
import {
  ActivityIndicator,
  Pressable,
  ScrollView,
  StyleSheet,
  TextInput,
  View,
} from "react-native";

import { discover } from "../modules/pinned-tls";
import { pair, type Saved } from "./host";
import { font } from "./theme";
import { Button, Mark, T, useColors } from "./ui";

export function Pairing({ onPaired }: { onPaired: (saved: Saved) => void }) {
  const c = useColors();
  const [found, setFound] = useState<{ name: string; route: string }[]>();
  const [route, setRoute] = useState("");
  const [code, setCode] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string>();

  const look = () => {
    setFound(undefined);
    void discover(3).then((hosts) => {
      setFound(hosts);
      if (hosts.length === 1) setRoute(hosts[0]!.route);
    });
  };
  useEffect(look, []);

  async function submit() {
    if (busy || !route.trim() || code.length < 6) return;
    setBusy(true);
    setError(undefined);
    try {
      onPaired(await pair(route.trim(), code, "iPhone"));
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setBusy(false);
    }
  }

  const input = [
    styles.input,
    { color: c.foreground, borderColor: c.border, backgroundColor: c.surface },
  ];
  return (
    <ScrollView
      style={{ backgroundColor: c.background }}
      contentContainerStyle={styles.page}
      keyboardShouldPersistTaps="handled"
    >
      <Mark size={36} />
      <T medium style={{ fontSize: 22, lineHeight: 30, marginTop: 8 }}>
        Pair with your computer
      </T>
      <T muted>
        On your computer, open Settings, then Connections, and choose Pair a device. Pick it here
        and enter the code it shows. A paired phone has full control of that computer.
      </T>

      <View style={styles.section}>
        <View style={styles.row}>
          <T muted style={{ fontSize: 13 }}>
            On this network
          </T>
          {found ? (
            <Pressable onPress={look} accessibilityRole="button">
              <T style={{ fontSize: 13, color: c.accent }}>Look again</T>
            </Pressable>
          ) : (
            <ActivityIndicator size="small" />
          )}
        </View>
        {found?.length === 0 && (
          <T muted style={{ fontSize: 13 }}>
            No computer is showing a code. Type its address below.
          </T>
        )}
        {found?.map((host) => (
          <Pressable
            key={host.name}
            accessibilityRole="button"
            onPress={() => setRoute(host.route)}
            style={[
              styles.host,
              {
                borderColor: route === host.route ? c.accent : c.border,
                backgroundColor: c.surface,
              },
            ]}
          >
            <T medium>{host.name}</T>
            <T muted style={{ fontSize: 13 }}>
              {host.route}
            </T>
          </Pressable>
        ))}
      </View>

      <TextInput
        accessibilityLabel="Address"
        placeholder="Address, such as 192.168.1.20"
        placeholderTextColor={c.faintForeground}
        value={route}
        onChangeText={setRoute}
        autoCapitalize="none"
        autoCorrect={false}
        keyboardType="numbers-and-punctuation"
        style={input}
      />
      <TextInput
        accessibilityLabel="Code"
        placeholder="7KQ-4M2"
        placeholderTextColor={c.faintForeground}
        onChangeText={setCode}
        autoCapitalize="characters"
        autoCorrect={false}
        textContentType="oneTimeCode"
        returnKeyType="go"
        onSubmitEditing={() => void submit()}
        style={[input, styles.code]}
      />
      <Button
        label={busy ? "Pairing…" : "Pair"}
        primary
        disabled={busy || !route.trim() || code.length < 6}
        onPress={() => void submit()}
      />
      {error && (
        <T alert style={{ color: c.danger }}>
          {error}
        </T>
      )}
    </ScrollView>
  );
}

const styles = StyleSheet.create({
  page: { padding: 24, paddingTop: 96, gap: 14 },
  section: { gap: 8, marginTop: 8 },
  row: { flexDirection: "row", justifyContent: "space-between", alignItems: "center" },
  host: { borderWidth: 1, borderRadius: 12, padding: 12 },
  input: {
    borderWidth: 1,
    borderRadius: 10,
    paddingHorizontal: 12,
    paddingVertical: 11,
    fontFamily: font.regular,
    fontSize: 16,
  },
  code: { fontFamily: font.mono, fontSize: 20, letterSpacing: 4 },
});
