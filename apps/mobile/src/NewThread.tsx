// A new thread: first the picker sheet, each repository once across every computer and then no
// repo, sliding over to which computer it runs on, with New orchestrator at its foot; then the new
// thread's page, the repository's icon and a greeting over the message box that starts it.
import type { NativeStackScreenProps } from "@react-navigation/native-stack";
import * as Haptics from "expo-haptics";
import { t } from "i18next";
import { ChevronDown, ChevronLeft, Layers, MonitorSmartphone, Plus, Search, SquareDashed } from "lucide-react-native";
import { useLayoutEffect, useRef, useState } from "react";
import {
  Animated,
  Keyboard,
  KeyboardAvoidingView,
  Pressable,
  ScrollView,
  StyleSheet,
  TextInput,
  View,
} from "react-native";
import { useHeaderHeight } from "@react-navigation/elements";
import { useSafeAreaInsets } from "react-native-safe-area-context";

import type { Repo } from "../../desktop/src/protocol/generated/protocol";
import { isRepository, noRepo } from "../../desktop/src/renderer/threads";
import { uuidv7 } from "../../desktop/src/renderer/uuidv7";
import { useAccount } from "./Account";
import { Composer, type Start } from "./Composer";
import { type Computer, useComputer, useFleet } from "./fleet";
import { greeting } from "./greeting";
import type { Screens } from "./nav";
import { orchestratorPlaces } from "./orchestratorLogic";
import { getPrefs, setPrefs } from "./prefs";
import { RepoIcon, useSharedIcons } from "./RepoIcon";
import { homeless } from "./Sidebar";
import { setStarted } from "./started";
import { Button, DeviceIcon, Icon, Section, T, useColors } from "./ui";

/** The default computer first, then the rest by name. */
export const ordered = (computers: Computer[], defaultId?: string) =>
  [...computers].sort(
    (a, b) =>
      Number(b.machine.id === defaultId) - Number(a.machine.id === defaultId) ||
      a.machine.name.localeCompare(b.machine.name),
  );

/** One computer a new thread can start on, and the repository there, none for no repo. */
interface Place {
  computer: Computer;
  repo?: Repo;
}

/** A row of the picker: a leading icon, a title, and a quiet subtitle. */
function Choice({
  leading,
  title,
  detail,
  label,
  disabled,
  last,
  onPress,
}: {
  leading: React.ReactNode;
  title: string;
  detail?: string;
  label: string;
  disabled?: boolean;
  last?: boolean;
  onPress: () => void;
}) {
  const c = useColors();
  return (
    <Pressable
      accessibilityRole="button"
      accessibilityLabel={label}
      disabled={disabled}
      onPress={onPress}
      style={({ pressed }) => [
        styles.row,
        !last && { borderBottomWidth: StyleSheet.hairlineWidth, borderColor: c.border },
        pressed && { backgroundColor: c.hover },
        disabled && { opacity: 0.4 },
      ]}
    >
      <View style={styles.glyph}>{leading}</View>
      <View style={{ flex: 1, gap: 1 }}>
        <T medium numberOfLines={1} style={{ fontSize: 16 }}>
          {title}
        </T>
        {detail && (
          <T faint numberOfLines={1} style={{ fontSize: 13, lineHeight: 17 }}>
            {detail}
          </T>
        )}
      </View>
    </Pressable>
  );
}

/**
 * The picker sheet: every repository once, by name, then no repo; a pick slides to the
 * computers that have it, and a computer opens the new thread's page there as the main view.
 */
export function NewThreadScreen({ navigation }: NativeStackScreenProps<Screens, "NewThread">) {
  const c = useColors();
  const insets = useSafeAreaInsets();
  const { computers, defaultId } = useFleet();
  const shared = useSharedIcons();
  const [query, setQuery] = useState("");
  // Past the home indicator, so the last row scrolls up to where it can be tapped.
  const page = [styles.page, { paddingBottom: insets.bottom + 24 }];
  /** The picked repository's name, null for no repo; kept while sliding back so the page stays drawn. */
  const [picked, setPicked] = useState<string | null>();
  const [step, setStep] = useState(0);
  const [width, setWidth] = useState(0);
  const slide = useRef(new Animated.Value(0)).current;
  const q = query.trim().toLowerCase();
  const machines = ordered(computers, defaultId);

  const byName = new Map<string, Place[]>();
  for (const computer of machines)
    for (const repo of computer.view.state.repos.filter(isRepository))
      byName.set(repo.name, [...(byName.get(repo.name) ?? []), { computer, repo }]);
  const names = [...byName.keys()]
    .filter((name) => !q || name.toLowerCase().includes(q))
    .sort((a, b) => a.localeCompare(b));
  const places: Place[] =
    picked === null ? machines.map((computer) => ({ computer })) : (byName.get(picked ?? "") ?? []);

  /** Slides to the computers (1) or back to the repositories (0). */
  function go(to: number) {
    setStep(to);
    Animated.spring(slide, { toValue: to, useNativeDriver: true, bounciness: 0, speed: 18 }).start();
  }

  function pickRepo(name: string | null) {
    void Haptics.selectionAsync();
    Keyboard.dismiss();
    setPicked(name);
    go(1);
  }

  function pickComputer(hostId: string, groupId: string) {
    void Haptics.selectionAsync();
    setPrefs({ lastStart: { hostId, groupId } });
    navigation.reset({ index: 0, routes: [{ name: "StartThread", params: { hostId, groupId } }] });
  }

  const translateX = slide.interpolate({ inputRange: [0, 1], outputRange: [0, -width] });
  return (
    <View
      style={{ flex: 1, overflow: "hidden", backgroundColor: c.background }}
      onLayout={(e) => setWidth(e.nativeEvent.layout.width)}
    >
      <Animated.View style={{ flex: 1, flexDirection: "row", width: width * 2, transform: [{ translateX }] }}>
        <ScrollView
          style={{ width }}
          contentContainerStyle={page}
          contentInsetAdjustmentBehavior="never"
          keyboardShouldPersistTaps="handled"
          automaticallyAdjustKeyboardInsets
          accessibilityElementsHidden={step !== 0}
          importantForAccessibility={step !== 0 ? "no-hide-descendants" : "auto"}
        >
          <T accessibilityRole="header" style={styles.title}>
            {t("New thread")}
          </T>
          <View style={[styles.search, { backgroundColor: c.selected }]}>
            <Icon icon={Search} size={16} color={c.faintForeground} />
            <TextInput
              accessibilityLabel={t("Search repositories")}
              value={query}
              onChangeText={setQuery}
              placeholder={t("Search repositories")}
              placeholderTextColor={c.faintForeground}
              autoCorrect={false}
              autoCapitalize="none"
              clearButtonMode="while-editing"
              style={[styles.input, { color: c.foreground }]}
            />
          </View>
          <Section>
            {names.length === 0 && (
              <T muted style={{ padding: 16, fontSize: 14 }}>
                {q ? t("No repository matches.") : t("No computer has a repository yet.")}
              </T>
            )}
            {names.map((name, i) => {
              const at = byName.get(name)!;
              return (
                <Choice
                  key={name}
                  leading={<RepoIcon repo={at[0]!.repo} shared={shared} size={28} />}
                  title={name}
                  detail={at.length === 1 ? at[0]!.computer.machine.name : t("{{count}} computers", { count: at.length, defaultValue_one: "{{count}} computer" })}
                  label={name}
                  last={i === names.length - 1}
                  onPress={() => pickRepo(name)}
                />
              );
            })}
          </Section>
          <Section>
            <Choice
              leading={<Icon icon={SquareDashed} size={24} color={c.faintForeground} />}
              title={t("No repo")}
              detail={t("A thread in a folder of its own")}
              label={t("No repo")}
              last
              onPress={() => pickRepo(null)}
            />
          </Section>
          {orchestratorPlaces(machines).length > 0 && (
            <Section>
              <Choice
                leading={<Icon icon={Layers} size={24} color={c.faintForeground} />}
                title={t("New orchestrator")}
                detail={t("A focused chat where agents coordinate work")}
                label={t("New orchestrator")}
                last
                onPress={() => {
                  void Haptics.selectionAsync();
                  Keyboard.dismiss();
                  navigation.navigate("NewOrchestrator");
                }}
              />
            </Section>
          )}
        </ScrollView>
        <ScrollView
          style={{ width }}
          contentContainerStyle={page}
          contentInsetAdjustmentBehavior="never"
          accessibilityElementsHidden={step !== 1}
          importantForAccessibility={step !== 1 ? "no-hide-descendants" : "auto"}
        >
          <View style={styles.stepHeader}>
            <Pressable
              accessibilityRole="button"
              accessibilityLabel={t("Back to repositories")}
              hitSlop={8}
              onPress={() => go(0)}
              style={({ pressed }) => [styles.back, { backgroundColor: pressed ? c.selected : c.hover }]}
            >
              <Icon icon={ChevronLeft} size={20} color={c.foreground} />
            </Pressable>
            <View style={{ flex: 1 }}>
              <T medium numberOfLines={1} style={{ fontSize: 17, fontWeight: "600" }}>
                {picked ?? t("No repo")}
              </T>
              <T faint style={{ fontSize: 13, lineHeight: 17 }}>
                {t("Which computer should it run on?")}
              </T>
            </View>
          </View>
          <Section>
            {places.map(({ computer, repo }, i) => (
              <Choice
                key={computer.machine.id}
                leading={<DeviceIcon name={computer.machine.name} size={22} color={c.mutedForeground} />}
                title={computer.machine.name}
                detail={[
                  repo && homeless(repo.path),
                  computer.machine.id === defaultId && t("Default"),
                  !computer.shownConnected && t("Offline"),
                ]
                  .filter(Boolean)
                  .join(" · ")}
                label={t("{{repo}} on {{computer}}", { repo: picked ?? t("No repo"), computer: computer.machine.name })}
                disabled={!computer.shownConnected}
                last={i === places.length - 1}
                onPress={() => pickComputer(computer.machine.id, repo?.id ?? noRepo)}
              />
            ))}
          </Section>
        </ScrollView>
      </Animated.View>
    </View>
  );
}

/**
 * A new thread's page, the app's home: the repository's icon, a greeting, and where it runs,
 * which opens the picker, over the message box. With no params, it starts where the last one did.
 */
export function StartThreadScreen({ route, navigation }: NativeStackScreenProps<Screens, "StartThread">) {
  const c = useColors();
  const insets = useSafeAreaInsets();
  const headerHeight = useHeaderHeight();
  const { computers, defaultId } = useFleet();
  const { user } = useAccount();
  const last = getPrefs().lastStart;
  const { hostId = "", groupId = noRepo } = route.params?.hostId
    ? route.params
    : last && computers.some((m) => m.machine.id === last.hostId)
      ? last
      : { hostId: defaultId ?? computers[0]?.machine.id, groupId: noRepo };
  const computer = useComputer(hostId);
  const [draft, setDraft] = useState("");
  const repo = groupId === noRepo ? undefined : computer?.view.state.repos.find((r) => r.id === groupId);
  const name = computer?.machine.name ?? t("this computer");
  const shared = useSharedIcons();

  useLayoutEffect(() => {
    navigation.setOptions({ title: "", headerTransparent: true, headerShadowVisible: false });
  }, [navigation]);

  async function start({ text, images, options }: Start) {
    if (!computer?.shownConnected) return t("{{name}} isn't connected.", { name });
    const runId = uuidv7();
    const at = repo ? groupId : noRepo;
    const failed = await computer.view.start({
      runId,
      groupId: at,
      prompt: text,
      images,
      threads: [],
      options,
      checkout: false,
    });
    if (failed) {
      const kind = failed.data?.kind;
      return kind === "noDefaultAccount" || kind === "accountNotFound"
        ? t("{{name}} has no default account. Choose one in its Settings › Accounts.", { name })
        : failed.message;
    }
    void Haptics.notificationAsync(Haptics.NotificationFeedbackType.Success);
    setPrefs({ lastStart: { hostId, groupId: at } });
    setStarted(runId, text);
    // In place, with no transition, so the page seems to become the thread.
    navigation.reset({ index: 0, routes: [{ name: "Thread", params: { hostId, runId, instant: true } }] });
    return undefined;
  }

  // No computer yet, as after skipping Find computers: where to add one, and no message box.
  if (computers.length === 0)
    return (
      <View style={[styles.middle, { paddingTop: headerHeight, backgroundColor: c.background }]}>
        <Icon icon={MonitorSmartphone} size={48} color={c.faintForeground} />
        <T style={styles.greeting}>{greeting(new Date().getHours(), user?.given_name)}</T>
        <T muted style={{ fontSize: 15, lineHeight: 21, textAlign: "center", paddingHorizontal: 32 }}>
          {t("Add a computer that runs Parallax to start threads on it from here.")}
        </T>
        <Button
          label={t("Add computer")}
          icon={Plus}
          primary
          onPress={() => navigation.navigate("Settings", { screen: "AddComputer", initial: false })}
        />
      </View>
    );

  return (
    <KeyboardAvoidingView behavior="padding" style={{ flex: 1, backgroundColor: c.background }}>
      <Pressable accessible={false} onPress={Keyboard.dismiss} style={[styles.middle, { paddingTop: headerHeight }]}>
        <RepoIcon repo={repo} shared={shared} size={64} />
        <T style={styles.greeting}>{greeting(new Date().getHours(), user?.given_name)}</T>
        <Pressable
          accessibilityRole="button"
          accessibilityLabel={t("{{repo}} on {{computer}}. Change", { repo: repo?.name ?? t("No repo"), computer: name })}
          hitSlop={10}
          onPress={() => {
            void Haptics.selectionAsync();
            navigation.navigate("NewThread");
          }}
          style={({ pressed }) => [styles.where, pressed && { opacity: 0.5 }]}
        >
          <T muted numberOfLines={1} style={{ fontSize: 15, flexShrink: 1 }}>
            {t("{{repo}} on {{computer}}", { repo: repo?.name ?? t("No repo"), computer: name })}
          </T>
          <Icon icon={ChevronDown} size={15} color={c.mutedForeground} />
        </Pressable>
      </Pressable>
      <Composer
        computer={computer}
        draft={draft}
        onDraft={setDraft}
        onStart={start}
        repo={repo?.id}
        placeholder={repo ? t("Ask anything in {{repo}}", { repo: repo.name }) : t("Ask anything")}
        bottom={Math.max(insets.bottom, 8)}
      />
    </KeyboardAvoidingView>
  );
}

const styles = StyleSheet.create({
  // Room on top for the sheet's grabber.
  page: { paddingHorizontal: 16, paddingTop: 22, gap: 18 },
  title: { fontSize: 17, fontWeight: "600", textAlign: "center", lineHeight: 22 },
  search: {
    height: 40,
    borderRadius: 12,
    flexDirection: "row",
    alignItems: "center",
    gap: 8,
    paddingHorizontal: 12,
  },
  input: { flex: 1, fontSize: 16, paddingVertical: 0 },
  row: { flexDirection: "row", alignItems: "center", gap: 14, paddingHorizontal: 14, paddingVertical: 12, minHeight: 60 },
  glyph: { width: 28, alignItems: "center" },
  stepHeader: { flexDirection: "row", alignItems: "center", gap: 12, paddingTop: 2 },
  back: { width: 34, height: 34, borderRadius: 17, alignItems: "center", justifyContent: "center" },
  middle: { flex: 1, alignItems: "center", justifyContent: "center", gap: 14, paddingHorizontal: 32 },
  greeting: { fontSize: 28, lineHeight: 34, fontWeight: "500", letterSpacing: -0.5, textAlign: "center", marginTop: 6 },
  where: { flexDirection: "row", alignItems: "center", gap: 4, maxWidth: "100%" },
});
