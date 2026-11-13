// A new orchestrator, as a sheet over the New thread picker: its name, its repository across every
// computer, and its first message, which plxd needs to start it. Creating starts it and makes its
// chat the main view. It takes the desktop form's default access and plxd's default autonomy.
import * as Haptics from "expo-haptics";
import { t } from "i18next";
import { useRef, useState } from "react";
import { ScrollView, StyleSheet, TextInput } from "react-native";
import { useSafeAreaInsets } from "react-native-safe-area-context";

import { uuidv7 } from "../../desktop/src/renderer/uuidv7";
import { Choices } from "./Choices";
import { useFleet } from "./fleet";
import { useShow } from "./nav";
import { ordered } from "./NewThread";
import { orchestratorPlaces, startOrchestrator } from "./orchestratorLogic";
import { RepoIcon, useSharedIcons } from "./RepoIcon";
import { homeless } from "./Sidebar";
import { setStarted } from "./started";
import { Button, Row, Section, T, useColors } from "./ui";

export function NewOrchestratorScreen() {
  const c = useColors();
  const insets = useSafeAreaInsets();
  const show = useShow();
  const { computers, defaultId } = useFleet();
  const shared = useSharedIcons();
  const places = orchestratorPlaces(ordered(computers, defaultId));
  const keyOf = (p: (typeof places)[number]) => `${p.computer.machine.id}/${p.repo.id}`;
  const [chosen, setChosen] = useState<string>();
  const [picking, setPicking] = useState(false);
  // The default computer's first repository until another is chosen, or if the chosen one's computer
  // goes offline.
  const place = places.find((p) => keyOf(p) === chosen) ?? places[0];
  // The repository's name until one is typed.
  const [typed, setTyped] = useState<string>();
  const name = (typed ?? place?.repo.name ?? "").trim();
  const [message, setMessage] = useState("");
  const prompt = message.trim();
  const [error, setError] = useState<string>();
  const [creating, setCreating] = useState(false);
  // The last try's ids, which a retry with the same computer, path, and name sends again (0007).
  const attempt = useRef<{ key: string; id: string; runId: string }>(undefined);

  async function create() {
    if (!place || !name || !prompt) return;
    const { computer, repo } = place;
    const hostId = computer.machine.id;
    const key = `${hostId}/${repo.path}/${name}`;
    const { id, runId } = attempt.current?.key === key ? attempt.current : { id: uuidv7(), runId: uuidv7() };
    attempt.current = { key, id, runId };
    setCreating(true);
    setError(undefined);
    // Full access, as the desktop's form starts with, where the computer keeps it.
    const permission = "orchestratorPermission" in computer.view.capabilities ? "bypass" : undefined;
    const made = await computer.view.createOrchestrator(id, name, repo.path, undefined, permission);
    const failed = typeof made === "string" ? made : await startOrchestrator(computer.view, id, runId, prompt);
    setCreating(false);
    if (failed) return setError(failed);
    void Haptics.notificationAsync(Haptics.NotificationFeedbackType.Success);
    setStarted(runId, prompt);
    show({ name: "Thread", params: { hostId, runId } });
  }

  return (
    <ScrollView
      style={{ backgroundColor: c.background }}
      contentContainerStyle={[styles.page, { paddingBottom: insets.bottom + 24 }]}
      contentInsetAdjustmentBehavior="never"
      keyboardShouldPersistTaps="handled"
      keyboardDismissMode="on-drag"
      automaticallyAdjustKeyboardInsets
    >
      <T accessibilityRole="header" style={styles.title}>
        {t("New orchestrator")}
      </T>
      <Section title={t("Name")}>
        <TextInput
          accessibilityLabel={t("Name")}
          value={typed ?? place?.repo.name ?? ""}
          onChangeText={setTyped}
          placeholder={t("New orchestrator")}
          placeholderTextColor={c.faintForeground}
          selectionColor={c.accent}
          autoCorrect={false}
          style={[styles.input, { color: c.foreground }]}
        />
      </Section>
      <Section title={t("Repository")}>
        <Row
          leading={place && <RepoIcon repo={place.repo} shared={shared} size={28} />}
          title={place?.repo.name ?? t("No repository")}
          detail={place && `${place.computer.machine.name} · ${homeless(place.repo.path)}`}
          chevron={places.length > 1}
          onPress={places.length > 1 ? () => setPicking(true) : undefined}
          last
        />
      </Section>
      <Section title={t("First message")}>
        <TextInput
          accessibilityLabel={t("First message")}
          value={message}
          onChangeText={setMessage}
          placeholder={t("Describe a feature or a bug")}
          placeholderTextColor={c.faintForeground}
          selectionColor={c.accent}
          multiline
          style={[styles.input, styles.message, { color: c.foreground }]}
        />
      </Section>
      {!!error && (
        <T alert style={{ color: c.danger, fontSize: 14 }}>
          {error}
        </T>
      )}
      <Button
        label={creating ? t("Creating…") : t("Create orchestrator")}
        primary
        disabled={!place || !name || !prompt || creating}
        onPress={() => void create()}
      />
      <Choices
        title={t("Repository")}
        open={picking}
        value={place && keyOf(place)}
        options={places.map((p) => ({
          value: keyOf(p),
          label: p.repo.name,
          description: `${p.computer.machine.name} · ${homeless(p.repo.path)}`,
        }))}
        onChoose={setChosen}
        onClose={() => setPicking(false)}
      />
    </ScrollView>
  );
}

const styles = StyleSheet.create({
  // Room on top for the sheet's grabber.
  page: { paddingHorizontal: 16, paddingTop: 22, gap: 18 },
  title: { fontSize: 17, fontWeight: "600", textAlign: "center", lineHeight: 22 },
  input: { fontSize: 16, paddingHorizontal: 14, paddingVertical: 12 },
  message: { minHeight: 96, textAlignVertical: "top" },
});
