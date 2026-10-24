// A sheet of choices from the bottom, as iOS's own pickers rise: a title, each choice with its
// icon and a line about it, and the chosen one checked. The composer's model, reasoning, and
// access pickers and the thread list's filters use it.
import * as Haptics from "expo-haptics";
import type { LucideIcon } from "lucide-react-native";
import { Check } from "lucide-react-native";
import { Modal, Pressable, ScrollView, StyleSheet, View } from "react-native";
import { useSafeAreaInsets } from "react-native-safe-area-context";

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
  value?: V;
  onChoose: (value: V) => void;
  onClose: () => void;
}) {
  const c = useColors();
  const insets = useSafeAreaInsets();
  return (
    <Modal visible={open} transparent animationType="slide" onRequestClose={onClose}>
      <Pressable style={styles.scrim} onPress={onClose} accessibilityLabel="Close" />
      <View
        style={[
          styles.sheet,
          { backgroundColor: c.surface, borderColor: c.border, paddingBottom: insets.bottom + 8 },
        ]}
      >
        <View style={[styles.grabber, { backgroundColor: c.border }]} />
        <T medium style={{ paddingHorizontal: 20, paddingBottom: 8 }}>
          {title}
        </T>
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
              accessibilityState={{ selected: o.value === value }}
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
              {o.value === value && <Icon icon={Check} size={17} color={c.accent} />}
            </Pressable>,
          ])}
        </ScrollView>
      </View>
    </Modal>
  );
}

const styles = StyleSheet.create({
  scrim: { flex: 1, backgroundColor: "rgba(0, 0, 0, 0.3)" },
  sheet: {
    borderTopLeftRadius: 22,
    borderTopRightRadius: 22,
    borderWidth: StyleSheet.hairlineWidth,
    paddingTop: 8,
  },
  grabber: { alignSelf: "center", width: 36, height: 5, borderRadius: 3, marginBottom: 10 },
  choice: { flexDirection: "row", alignItems: "center", gap: 12, paddingHorizontal: 20, paddingVertical: 12 },
  section: { fontSize: 12, letterSpacing: 0.4, paddingHorizontal: 20, paddingTop: 14, paddingBottom: 4 },
});
