// A sheet of choices from the bottom, as iOS's own pickers rise: a title, each choice with its
// icon and a line about it, and the chosen one checked. Settings' pickers and the thread list's
// filters use it.
import * as Haptics from "expo-haptics";
import type { LucideIcon } from "lucide-react-native";
import { Check } from "lucide-react-native";
import { Pressable, StyleSheet, View } from "react-native";
import { ScrollView } from "react-native-gesture-handler";

import { Sheet, sheetTitle } from "./Sheet";
import { Icon, T, useColors } from "./ui";

/** One choice: its value, label, line, icon, and a count or note on its right. */
export interface Choice<V extends string> {
  value: V;
  label: string;
  description?: string;
  icon?: LucideIcon;
  right?: string;
  /** A heading this choice starts under. */
  section?: string;
}

/** A sheet of choices from the bottom, each with its icon and line, the chosen one checked. */
export function Choices<V extends string>({
  title,
  open,
  options,
  value,
  onChoose,
  onClose,
}: {
  title: string;
  open: boolean;
  options: Choice<V>[];
  /** The chosen value, or several, one from each section. */
  value?: V | V[];
  onChoose: (value: V) => void;
  onClose: () => void;
}) {
  const c = useColors();
  return (
    <Sheet
      open={open}
      onClose={onClose}
      head={
        <View style={styles.head}>
          <T style={sheetTitle}>{title}</T>
        </View>
      }
    >
      <ScrollView style={{ maxHeight: 460 }}>
        {options.map((o) => [
          o.section && (
            <T key={`s${o.section}`} muted style={styles.section}>
              {o.section.toUpperCase()}
            </T>
          ),
          <Pressable
            key={o.value}
            accessibilityRole="radio"
            accessibilityState={{ selected: Array.isArray(value) ? value.includes(o.value) : o.value === value }}
            onPress={() => {
              void Haptics.selectionAsync();
              onChoose(o.value);
              onClose();
            }}
            style={({ pressed }) => [styles.choice, pressed && { backgroundColor: c.selected }]}
          >
            {o.icon && <Icon icon={o.icon} size={17} color={c.mutedForeground} />}
            <View style={{ flex: 1 }}>
              <T>{o.label}</T>
              {o.description && (
                <T muted style={{ fontSize: 13, lineHeight: 18 }}>
                  {o.description}
                </T>
              )}
            </View>
            {!!o.right && <T faint style={{ fontSize: 13 }}>{o.right}</T>}
            {(Array.isArray(value) ? value.includes(o.value) : o.value === value) && (
              <Icon icon={Check} size={17} color={c.accent} />
            )}
          </Pressable>,
        ])}
      </ScrollView>
    </Sheet>
  );
}

const styles = StyleSheet.create({
  head: { height: 24, marginBottom: 6 },
  choice: { flexDirection: "row", alignItems: "center", gap: 12, paddingHorizontal: 20, paddingVertical: 12 },
  section: { fontSize: 12, letterSpacing: 0.4, paddingHorizontal: 20, paddingTop: 14, paddingBottom: 4 },
});
