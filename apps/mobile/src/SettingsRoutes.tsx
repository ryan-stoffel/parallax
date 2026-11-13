// An account computer's routes on this phone (0091): how they're tried, best first, moved with
// arrows, and an address to add. Only an added route has a remove button.
import type { NativeStackScreenProps } from "@react-navigation/native-stack";
import { t } from "i18next";
import { ChevronDown, ChevronUp, Plus, Trash2, type LucideIcon } from "lucide-react-native";
import { useState } from "react";
import { Pressable, ScrollView, StyleSheet, View } from "react-native";

import { useComputer, useFleet } from "./fleet";
import type { SettingsScreens } from "./nav";
import { isRelay, ordered } from "./routes";
import { Icon, Input, Row, Section, T, useColors } from "./ui";

/** A small icon button on a route's row. */
function RouteButton({
  icon,
  label,
  disabled,
  onPress,
}: {
  icon: LucideIcon;
  label: string;
  disabled?: boolean;
  onPress: () => void;
}) {
  const c = useColors();
  return (
    <Pressable
      accessibilityRole="button"
      accessibilityLabel={label}
      accessibilityState={{ disabled: !!disabled }}
      disabled={disabled}
      onPress={onPress}
      hitSlop={4}
      style={[styles.button, disabled && { opacity: 0.3 }]}
    >
      <Icon icon={icon} size={18} color={c.mutedForeground} />
    </Pressable>
  );
}

export function ComputerRoutesScreen({ route }: NativeStackScreenProps<SettingsScreens, "ComputerRoutes">) {
  const c = useColors();
  const { id } = route.params;
  const m = useComputer(id);
  const { editRoutes, routeOf } = useFleet();
  const [typed, setTyped] = useState("");
  const [error, setError] = useState<string>();
  const account = m?.machine.account;
  if (!account) return null;
  const list = ordered(account.hostId, account);
  const on = m.shownConnected ? routeOf(id) : undefined;
  const add = () => {
    const why = editRoutes(id, { add: typed });
    setError(why);
    if (!why) setTyped("");
  };
  return (
    <ScrollView
      style={{ backgroundColor: c.background }}
      contentInsetAdjustmentBehavior="automatic"
      contentContainerStyle={{ padding: 16, gap: 24, paddingBottom: 40 }}
      keyboardShouldPersistTaps="handled"
      automaticallyAdjustKeyboardInsets
    >
      <Section
        title={t("Tried in this order")}
        footer={t(
          "Until you move one, direct routes start together and Parallax Connect 200 ms later. Saved on this phone. Parallax Connect stays, as the route that works from anywhere.",
        )}
      >
        {list.map((each, i) => {
          const name = isRelay(each) ? "Parallax Connect" : each;
          return (
            <Row
              key={each}
              title={name}
              detail={[account.addedRoutes?.includes(each) && t("Added"), each === on && t("Connected")].filter(Boolean).join(" · ")}
              last={i === list.length - 1}
              right={
                <View style={styles.buttons}>
                  <RouteButton
                    icon={ChevronUp}
                    label={t("Move {{name}} up", { name })}
                    disabled={i === 0}
                    onPress={() => setError(editRoutes(id, { move: each, by: -1 }))}
                  />
                  <RouteButton
                    icon={ChevronDown}
                    label={t("Move {{name}} down", { name })}
                    disabled={i === list.length - 1}
                    onPress={() => setError(editRoutes(id, { move: each, by: 1 }))}
                  />
                  {account.addedRoutes?.includes(each) && (
                    <RouteButton
                      icon={Trash2}
                      label={t("Remove {{name}}", { name })}
                      onPress={() => setError(editRoutes(id, { remove: each }))}
                    />
                  )}
                </View>
              }
            />
          );
        })}
      </Section>
      <View style={{ gap: 6 }}>
        <T muted style={styles.title}>
          {t("Add a route")}
        </T>
        <View style={styles.add}>
          <Input
            mono
            accessibilityLabel={t("Address")}
            value={typed}
            onChangeText={setTyped}
            onSubmitEditing={add}
            placeholder="192.168.1.20:7400"
            keyboardType="url"
            returnKeyType="done"
            style={{ flex: 1 }}
          />
          <RouteButton icon={Plus} label={t("Add route")} onPress={add} />
        </View>
        {!!error && (
          <T alert style={{ color: c.danger, fontSize: 13, paddingHorizontal: 4 }}>
            {error}
          </T>
        )}
        <T faint style={styles.note}>
          {t(
            "An IP address or .local name of this computer, with a port if it isn't 7341. It must present this computer's key before anything is sent. plxd only accepts connections from private networks, so a port forward from the internet won't connect.",
          )}
        </T>
      </View>
    </ScrollView>
  );
}

const styles = StyleSheet.create({
  buttons: { flexDirection: "row", alignItems: "center", gap: 2 },
  button: { padding: 6 },
  add: { flexDirection: "row", alignItems: "center", gap: 6 },
  title: { fontSize: 13, paddingHorizontal: 4 },
  note: { fontSize: 13, lineHeight: 18, paddingHorizontal: 4 },
});
