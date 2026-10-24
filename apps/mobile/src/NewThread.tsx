// A new thread, on the default computer or another, in one of its repositories or none, with
// the computer's default model and account, as the desktop's New thread starts one with none
// picked.
import type { NativeStackScreenProps } from "@react-navigation/native-stack";
import * as Haptics from "expo-haptics";
import { useLayoutEffect, useState } from "react";
import { Pressable, ScrollView, StyleSheet, TextInput, View } from "react-native";

import { isRepository, noRepo } from "../../desktop/src/renderer/threads";
import { uuidv7 } from "../../desktop/src/renderer/uuidv7";
import { useFleet } from "./fleet";
import type { Screens } from "./nav";
import { font } from "./theme";
import { DeviceIcon, Dot, T, useColors } from "./ui";

export function NewThreadScreen({ navigation }: NativeStackScreenProps<Screens, "NewThread">) {
  const c = useColors();
  const { computers, defaultId } = useFleet();
  const [hostId, setHostId] = useState(defaultId ?? computers[0]?.machine.id);
  const computer = computers.find((m) => m.machine.id === hostId);
  const repos = (computer?.view.state.repos ?? []).filter(isRepository);
  const [groupId, setGroupId] = useState<string>();
  const group = groupId && repos.some((r) => r.id === groupId) ? groupId : (repos[0]?.id ?? noRepo);
  const [prompt, setPrompt] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string>();
  const ready = !!computer?.connected && !!prompt.trim() && !busy;

  async function start() {
    if (!ready) return;
    setBusy(true);
    setError(undefined);
    const runId = uuidv7();
    const failed = await computer.view.start({
      runId,
      groupId: group,
      prompt: prompt.trim(),
      images: [],
      threads: [],
      options: {},
      checkout: false,
    });
    setBusy(false);
    if (failed) {
      const kind = failed.data?.kind;
      return setError(
        kind === "noDefaultAccount" || kind === "accountNotFound"
          ? `${computer.machine.name} has no default account. Choose one in its Parallax Settings › Accounts.`
          : failed.message,
      );
    }
    void Haptics.notificationAsync(Haptics.NotificationFeedbackType.Success);
    navigation.replace("Thread", { hostId: computer.machine.id, runId });
  }

  useLayoutEffect(() => {
    navigation.setOptions({
      headerLeft: () => (
        <Pressable accessibilityRole="button" hitSlop={10} onPress={() => navigation.goBack()}>
          <T style={{ color: c.accent }}>Cancel</T>
        </Pressable>
      ),
      headerRight: () => (
        <Pressable accessibilityRole="button" hitSlop={10} disabled={!ready} onPress={() => void start()}>
          <T medium style={{ color: ready ? c.accent : c.faintForeground }}>
            {busy ? "Starting…" : "Start"}
          </T>
        </Pressable>
      ),
    });
  });

  const chip = (key: string, label: string, on: boolean, onPress: () => void, extra?: React.ReactNode) => (
    <Pressable
      key={key}
      accessibilityRole="radio"
      accessibilityState={{ selected: on }}
      onPress={onPress}
      style={[
        styles.chip,
        { backgroundColor: on ? c.accent : c.surface, borderColor: on ? c.accent : c.border },
      ]}
    >
      {extra}
      <T medium style={{ fontSize: 13, lineHeight: 17, color: on ? "#ffffff" : c.foreground }}>
        {label}
      </T>
    </Pressable>
  );

  return (
    <ScrollView
      style={{ backgroundColor: c.background }}
      contentContainerStyle={styles.page}
      keyboardShouldPersistTaps="handled"
    >
      <TextInput
        accessibilityLabel="Prompt"
        autoFocus
        multiline
        value={prompt}
        onChangeText={setPrompt}
        placeholder="What should the agent do?"
        placeholderTextColor={c.faintForeground}
        style={[styles.prompt, { color: c.foreground, backgroundColor: c.surface, borderColor: c.border }]}
      />
      <T muted medium style={styles.label}>
        Computer
      </T>
      <ScrollView horizontal showsHorizontalScrollIndicator={false} contentContainerStyle={styles.chips}>
        {computers.map((m) =>
          chip(
            m.machine.id,
            m.machine.name,
            m.machine.id === hostId,
            () => setHostId(m.machine.id),
            <>
              <DeviceIcon
                name={m.machine.name}
                size={13}
                color={m.machine.id === hostId ? "#ffffff" : c.mutedForeground}
              />
              {!m.connected && <Dot color={c.faintForeground} size={6} />}
            </>,
          ),
        )}
      </ScrollView>
      <T muted medium style={styles.label}>
        Repository
      </T>
      <View style={[styles.chips, { flexWrap: "wrap" }]}>
        {repos.map((r) => chip(r.id, r.name, group === r.id, () => setGroupId(r.id)))}
        {chip(noRepo, "No repo", group === noRepo, () => setGroupId(noRepo))}
      </View>
      <T faint style={{ fontSize: 13, lineHeight: 18 }}>
        {group === noRepo
          ? "A chat with no repository."
          : "It works in a new worktree and branch, with the computer's default model and account."}
      </T>
      {!computer?.connected && (
        <T alert style={{ color: c.warning, fontSize: 14 }}>
          {computer ? `${computer.machine.name} isn't connected.` : "Add a computer first."}
        </T>
      )}
      {error && (
        <T alert style={{ color: c.danger, fontSize: 14 }}>
          {error}
        </T>
      )}
    </ScrollView>
  );
}

const styles = StyleSheet.create({
  page: { padding: 16, gap: 10 },
  prompt: {
    minHeight: 140,
    borderWidth: StyleSheet.hairlineWidth,
    borderRadius: 16,
    padding: 14,
    paddingTop: 14,
    fontFamily: font.regular,
    fontSize: 16,
    lineHeight: 22,
    textAlignVertical: "top",
  },
  label: { fontSize: 13, marginTop: 8 },
  chips: { flexDirection: "row", gap: 8 },
  chip: {
    flexDirection: "row",
    alignItems: "center",
    gap: 6,
    borderWidth: 1,
    borderRadius: 999,
    paddingHorizontal: 12,
    paddingVertical: 7,
  },
});
