// A new thread, as the desktop starts one: first the repository picker, every computer's
// repositories with where each lives, and no repo on each computer; then the new thread's page,
// "What should we build in <repo> on <computer>?" over the message box that starts it.
import type { NativeStackScreenProps } from "@react-navigation/native-stack";
import * as Haptics from "expo-haptics";
import { Search, SquareDashed } from "lucide-react-native";
import { useLayoutEffect, useMemo, useState } from "react";
import { KeyboardAvoidingView, Pressable, ScrollView, StyleSheet, TextInput, View } from "react-native";
import { useHeaderHeight } from "@react-navigation/elements";
import { useSafeAreaInsets } from "react-native-safe-area-context";

import { isRepository, noRepo } from "../../desktop/src/renderer/threads";
import { uuidv7 } from "../../desktop/src/renderer/uuidv7";
import { Composer, type Start } from "./Composer";
import { type Computer, useComputer, useFleet } from "./fleet";
import type { Screens } from "./nav";
import { RepoIcon, useSharedIcons } from "./RepoIcon";
import { font } from "./theme";
import { DeviceIcon, Icon, Section, T, useColors } from "./ui";

/** `path` with the home folder as `~`. */
const homeless = (path: string) =>
  path
    .replace(/^\\\\\?\\/, "")
    .replace(/^(\/Users|\/home)\/[^/]+/, "~")
    .replace(/^[A-Z]:\\Users\\[^\\]+/i, "~");

/** The default computer first, then the rest by name. */
const ordered = (computers: Computer[], defaultId?: string) =>
  [...computers].sort(
    (a, b) =>
      Number(b.machine.id === defaultId) - Number(a.machine.id === defaultId) ||
      a.machine.name.localeCompare(b.machine.name),
  );

export function NewThreadScreen({ navigation }: NativeStackScreenProps<Screens, "NewThread">) {
  const c = useColors();
  const { computers, defaultId } = useFleet();
  const shared = useSharedIcons();
  const [query, setQuery] = useState("");
  const q = query.trim().toLowerCase();
  const machines = ordered(computers, defaultId);
  const repos = machines.flatMap((m) =>
    m.view.state.repos
      .filter(isRepository)
      .filter((r) => !q || r.name.toLowerCase().includes(q) || m.machine.name.toLowerCase().includes(q))
      .sort((a, b) => a.name.localeCompare(b.name))
      .map((repo) => ({ computer: m, repo })),
  );
  const several = computers.length > 1;

  /** Opens the new thread's page, or changes the one this picker came from. */
  function pick(hostId: string, groupId: string) {
    void Haptics.selectionAsync();
    const params = { hostId, groupId };
    if (navigation.getState().routes.some((r) => r.name === "StartThread"))
      navigation.popTo("StartThread", params);
    else navigation.replace("StartThread", params);
  }

  return (
    <ScrollView
      style={{ backgroundColor: c.background }}
      contentContainerStyle={styles.page}
      keyboardShouldPersistTaps="handled"
      automaticallyAdjustKeyboardInsets
    >
      <View style={[styles.search, { backgroundColor: c.surface, borderColor: c.border }]}>
        <Icon icon={Search} size={16} color={c.faintForeground} />
        <TextInput
          accessibilityLabel="Search repositories"
          value={query}
          onChangeText={setQuery}
          placeholder="Search repositories"
          placeholderTextColor={c.faintForeground}
          autoCorrect={false}
          autoCapitalize="none"
          clearButtonMode="while-editing"
          style={[styles.input, { color: c.foreground }]}
        />
      </View>
      <Section title="Repositories">
        {repos.length === 0 && (
          <T muted style={{ padding: 16, fontSize: 14 }}>
            {q ? "No repository matches." : "No computer has a repository yet."}
          </T>
        )}
        {repos.map(({ computer, repo }, i) => (
          <Pressable
            key={`${computer.machine.id}/${repo.id}`}
            accessibilityRole="button"
            accessibilityLabel={`${repo.name} on ${computer.machine.name}`}
            disabled={!computer.connected}
            onPress={() => pick(computer.machine.id, repo.id)}
            style={({ pressed }) => [
              styles.row,
              i < repos.length - 1 && { borderBottomWidth: StyleSheet.hairlineWidth, borderColor: c.border },
              pressed && { backgroundColor: c.hover },
              !computer.connected && { opacity: 0.45 },
            ]}
          >
            <RepoIcon repo={repo} shared={shared} size={26} />
            <View style={{ flex: 1, gap: 1 }}>
              <T medium numberOfLines={1} style={{ fontSize: 16, fontWeight: "500" }}>
                {repo.name}
              </T>
              <T faint numberOfLines={1} style={{ fontSize: 13, lineHeight: 17 }}>
                {[several && computer.machine.name, homeless(repo.path), !computer.connected && "offline"]
                  .filter(Boolean)
                  .join(" · ")}
              </T>
            </View>
          </Pressable>
        ))}
      </Section>
      {!q && (
        <Section title="Without a repo">
          {machines.map((m, i) => (
            <Pressable
              key={m.machine.id}
              accessibilityRole="button"
              accessibilityLabel={`No repo on ${m.machine.name}`}
              disabled={!m.connected}
              onPress={() => pick(m.machine.id, noRepo)}
              style={({ pressed }) => [
                styles.row,
                i < machines.length - 1 && {
                  borderBottomWidth: StyleSheet.hairlineWidth,
                  borderColor: c.border,
                },
                pressed && { backgroundColor: c.hover },
                !m.connected && { opacity: 0.45 },
              ]}
            >
              <View style={styles.glyph}>
                <Icon icon={SquareDashed} size={22} color={c.faintForeground} />
              </View>
              <View style={{ flex: 1, gap: 1 }}>
                <T medium style={{ fontSize: 16, fontWeight: "500" }}>
                  No repo
                </T>
                <View style={{ flexDirection: "row", alignItems: "center", gap: 5 }}>
                  <DeviceIcon name={m.machine.name} size={12} color={c.faintForeground} />
                  <T faint numberOfLines={1} style={{ fontSize: 13, lineHeight: 17 }}>
                    {m.machine.name}
                    {!m.connected && " · offline"}
                  </T>
                </View>
              </View>
            </Pressable>
          ))}
        </Section>
      )}
    </ScrollView>
  );
}

export function StartThreadScreen({ route, navigation }: NativeStackScreenProps<Screens, "StartThread">) {
  const { hostId = "", groupId = noRepo } = route.params ?? {};
  const c = useColors();
  const insets = useSafeAreaInsets();
  const headerHeight = useHeaderHeight();
  const computer = useComputer(hostId);
  const [draft, setDraft] = useState("");
  const repo = useMemo(
    () => (groupId === noRepo ? undefined : computer?.view.state.repos.find((r) => r.id === groupId)),
    [computer, groupId],
  );
  const name = computer?.machine.name ?? "this computer";
  const shared = useSharedIcons();

  useLayoutEffect(() => {
    navigation.setOptions({ title: "", headerShadowVisible: false });
  }, [navigation]);

  async function start({ text, images, options }: Start) {
    if (!computer?.connected) return `${name} isn't connected.`;
    const runId = uuidv7();
    const failed = await computer.view.start({
      runId,
      groupId: repo ? groupId : noRepo,
      prompt: text,
      images,
      threads: [],
      options,
      checkout: false,
    });
    if (failed) {
      const kind = failed.data?.kind;
      return kind === "noDefaultAccount" || kind === "accountNotFound"
        ? `${name} has no default account. Choose one in its Settings › Accounts.`
        : failed.message;
    }
    void Haptics.notificationAsync(Haptics.NotificationFeedbackType.Success);
    navigation.replace("Thread", { hostId, runId });
    return undefined;
  }

  const change = () => navigation.navigate("NewThread");
  const link = {
    textDecorationLine: "underline",
    textDecorationStyle: "dotted",
    textDecorationColor: c.mutedForeground,
  } as const;
  return (
    <KeyboardAvoidingView
      behavior="padding"
      keyboardVerticalOffset={headerHeight}
      style={{ flex: 1, backgroundColor: c.background }}
    >
      <Pressable accessible={false} style={styles.middle}>
        <RepoIcon repo={repo} shared={shared} size={44} />
        <T medium style={styles.heading}>
          {repo ? "What should we build in " : "What should we work on "}
          <T medium accessibilityRole="button" onPress={change} style={{ ...styles.heading, ...link }}>
            {repo ? repo.name : "without a repo"}
          </T>
          {" on "}
          <T medium accessibilityRole="button" onPress={change} style={{ ...styles.heading, ...link }}>
            {name}
          </T>
          ?
        </T>
        {repo && (
          <Pressable
            accessibilityRole="button"
            hitSlop={8}
            onPress={() => navigation.setParams({ groupId: noRepo })}
          >
            <T muted style={{ fontSize: 15 }}>
              or start without a repo
            </T>
          </Pressable>
        )}
        {repo && (
          <T faint numberOfLines={1} style={{ fontSize: 13, fontFamily: font.mono }}>
            {homeless(repo.path)}
          </T>
        )}
      </Pressable>
      <Composer
        computer={computer}
        draft={draft}
        onDraft={setDraft}
        onStart={start}
        placeholder={repo ? `Ask anything in ${repo.name}` : "Ask anything"}
        bottom={Math.max(insets.bottom, 8)}
      />
    </KeyboardAvoidingView>
  );
}

const styles = StyleSheet.create({
  page: { padding: 16, gap: 22 },
  search: {
    height: 42,
    borderRadius: 12,
    borderWidth: StyleSheet.hairlineWidth,
    flexDirection: "row",
    alignItems: "center",
    gap: 8,
    paddingHorizontal: 12,
  },
  input: { flex: 1, fontSize: 16, paddingVertical: 0 },
  row: { flexDirection: "row", alignItems: "center", gap: 12, paddingHorizontal: 14, paddingVertical: 11 },
  glyph: { width: 26, alignItems: "center" },
  middle: { flex: 1, alignItems: "center", justifyContent: "center", gap: 14, paddingHorizontal: 28 },
  heading: { fontSize: 24, lineHeight: 32, fontWeight: "500", textAlign: "center", letterSpacing: -0.3 },
});
