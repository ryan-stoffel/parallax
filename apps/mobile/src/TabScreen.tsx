// A screen that opens as the desktop's sidebar does, now only the pull requests sheet's (the
// sidebar draws its own sky, Sidebar.tsx): its top row on the nightly sky, the wordmark and
// actions, and below it on the sky, a search field where the screen has one. The sky fades into
// the page before the content starts, so nothing scrolls under it. Content opens with
// `ScreenTitle`.
import { useFocusEffect, useIsFocused } from "@react-navigation/native";
import { Search, X } from "lucide-react-native";
import { useCallback, type ReactNode } from "react";
import { Pressable, StatusBar, StyleSheet, TextInput, View } from "react-native";
import { useSafeAreaInsets } from "react-native-safe-area-context";

import { Icon, SkyBanner, T, useColors, Wordmark } from "./ui";

const ROW = 52;
const SEARCH = 52;
const FADE = 36;

export function TabScreen({
  actions,
  search,
  children,
}: {
  actions?: ReactNode;
  search?: { value: string; onChange: (text: string) => void; placeholder: string };
  children: ReactNode;
}) {
  const c = useColors();
  const insets = useSafeAreaInsets();
  // Light status bar text over the sky while this tab shows; the system's on other screens.
  useFocusEffect(
    useCallback(() => {
      StatusBar.setBarStyle("light-content", true);
      return () => StatusBar.setBarStyle("default", true);
    }, []),
  );
  // The sky only while this tab is in front: a screen pushed over it would see it through its
  // header, whose glass buttons iOS then tints dark.
  const focused = useIsFocused();
  const bar = insets.top + ROW;
  const solid = bar + (search ? SEARCH : 0);
  return (
    <View style={{ flex: 1, backgroundColor: c.background }}>
      <View style={{ height: solid + FADE }}>
        {focused && <SkyBanner bar={bar} solid={solid} fade={FADE} />}
        <View style={[styles.row, { marginTop: insets.top }]}>
          <Wordmark color="#ffffff" />
          <View style={styles.actions}>{actions}</View>
        </View>
        {search && (
          <View style={styles.search}>
            <Icon icon={Search} size={16} color="rgba(255, 255, 255, 0.7)" />
            <TextInput
              accessibilityLabel={search.placeholder}
              value={search.value}
              onChangeText={search.onChange}
              placeholder={search.placeholder}
              placeholderTextColor="rgba(255, 255, 255, 0.55)"
              selectionColor="#ffffff"
              autoCorrect={false}
              returnKeyType="search"
              keyboardAppearance="dark"
              style={styles.input}
            />
            {!!search.value && (
              <Pressable accessibilityRole="button" accessibilityLabel="Clear" hitSlop={10} onPress={() => search.onChange("")}>
                <Icon icon={X} size={15} color="rgba(255, 255, 255, 0.8)" />
              </Pressable>
            )}
          </View>
        )}
      </View>
      <View style={{ flex: 1 }}>{children}</View>
    </View>
  );
}

/** A tab's large title, at the top of its content. */
export function ScreenTitle({ children, right }: { children: string; right?: ReactNode }) {
  return (
    <View style={styles.title}>
      <T style={{ fontSize: 32, lineHeight: 38, fontWeight: "700", flex: 1 }}>{children}</T>
      {right}
    </View>
  );
}

const styles = StyleSheet.create({
  row: {
    height: ROW,
    flexDirection: "row",
    alignItems: "center",
    justifyContent: "space-between",
    paddingHorizontal: 16,
  },
  actions: { flexDirection: "row", gap: 10 },
  search: {
    height: 40,
    marginHorizontal: 16,
    marginTop: 4,
    borderRadius: 12,
    flexDirection: "row",
    alignItems: "center",
    gap: 8,
    paddingHorizontal: 12,
    backgroundColor: "rgba(255, 255, 255, 0.12)",
    borderWidth: StyleSheet.hairlineWidth,
    borderColor: "rgba(255, 255, 255, 0.2)",
  },
  input: { flex: 1, color: "#ffffff", fontSize: 16, paddingVertical: 0 },
  title: { flexDirection: "row", alignItems: "center", paddingHorizontal: 20, paddingTop: 4, paddingBottom: 8 },
});
