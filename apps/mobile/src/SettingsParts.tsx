// The pieces a computer's settings pages share: the page, the computer it applies to with a
// picker for another, a computer's host settings, rows for a switch, a text field, and a line of
// text, and failures as alerts.
import { ChevronsUpDown } from "lucide-react-native";
import { useEffect, useState, type ComponentProps, type ReactNode } from "react";
import { Alert, ScrollView, StyleSheet, Switch, TextInput, View } from "react-native";

import type { RpcError } from "../../desktop/src/preload/bridge";
import type {
  HostSettings,
  HostSettingsSetParams,
} from "../../desktop/src/protocol/generated/protocol";
import { describeError } from "../../desktop/src/renderer/errors";
import { Choices } from "./Choices";
import { useFleet, type Computer } from "./fleet";
import { font } from "./theme";
import { DeviceIcon, Icon, Row, Section, T, useColors } from "./ui";

/** Says what couldn't be done, and why. */
export const fail = (title: string, why: RpcError | string) =>
  Alert.alert(title, typeof why === "string" ? why : describeError(why));

/** Whether a connected computer's plxd has `capability`. */
export const can = (m: Computer, capability: string) =>
  m.state.status === "connected" && capability in m.state.capabilities;

/** A pushed settings page: grouped sections on the page's background. */
export function Page({ children }: { children: ReactNode }) {
  const c = useColors();
  return (
    <ScrollView
      style={{ backgroundColor: c.background }}
      contentContainerStyle={{ padding: 16, gap: 24, paddingBottom: 48 }}
      keyboardShouldPersistTaps="handled"
      automaticallyAdjustKeyboardInsets
    >
      {children}
    </ScrollView>
  );
}

/** The computer a page's settings apply to, and with more than one, a sheet to pick another. */
export function ComputerPicker({ m, onChange }: { m: Computer; onChange: (id: string) => void }) {
  const c = useColors();
  const { computers } = useFleet();
  const [open, setOpen] = useState(false);
  const more = computers.length > 1;
  return (
    <Section footer={`Changes here apply to ${m.machine.name}.`}>
      <Row
        leading={<DeviceIcon name={m.machine.name} size={18} color={c.mutedForeground} />}
        title={m.machine.name}
        detail={m.connected ? "Connected" : m.state.status === "failed" ? m.state.error.message : "Connecting…"}
        last
        onPress={more ? () => setOpen(true) : undefined}
        right={more ? <Icon icon={ChevronsUpDown} size={16} color={c.faintForeground} /> : undefined}
      />
      <Choices
        title="Computer"
        open={open}
        value={m.machine.id}
        options={computers.map((x) => ({
          value: x.machine.id,
          label: x.machine.name,
          description: x.connected ? "Connected" : "Not connected",
        }))}
        onChoose={onChange}
        onClose={() => setOpen(false)}
      />
    </Section>
  );
}

/**
 * A computer's host settings (`host/settings`), and `set`, which shows a change at once, then
 * plxd's answer, or puts it back and says why it failed.
 */
export function useHostSettings(m: Computer) {
  const id = m.machine.id;
  const [settings, setSettings] = useState<HostSettings>();
  const [error, setError] = useState<string>();
  // Read once the computer connects, and again after each reconnect.
  useEffect(() => {
    if (!m.connected) return;
    let live = true;
    void window.parallax.request(id, "host/settings/get", {}).then((answer) => {
      if (!live) return;
      if ("error" in answer) setError(describeError(answer.error));
      else setSettings(answer.result);
    });
    return () => {
      live = false;
    };
  }, [id, m.connected]);
  const set = async (change: HostSettingsSetParams, title: string) => {
    const before = settings;
    setSettings((s) => s && { ...s, ...change });
    const answer = await window.parallax.request(id, "host/settings/set", change);
    if ("error" in answer) {
      setSettings(before);
      fail(title, answer.error);
    } else setSettings(answer.result);
  };
  return { settings, error, set };
}

/** A row with a switch on its right. */
export function SwitchRow({
  title,
  detail,
  value,
  onChange,
  disabled,
  last,
}: {
  title: string;
  detail?: string;
  value: boolean;
  onChange: (on: boolean) => void;
  disabled?: boolean;
  last?: boolean;
}) {
  return (
    <Row
      title={title}
      detail={detail}
      last={last}
      right={<Switch accessibilityLabel={title} value={value} disabled={disabled} onValueChange={onChange} />}
    />
  );
}

/** A block in a section, with the rows' padding and the line under it. */
export function Block({ children, last, style }: { children: ReactNode; last?: boolean; style?: object }) {
  const c = useColors();
  return (
    <View
      style={[
        styles.block,
        !last && { borderBottomColor: c.border, borderBottomWidth: StyleSheet.hairlineWidth },
        style,
      ]}
    >
      {children}
    </View>
  );
}

/** A line of text in a section, such as "Loading…" or why a page can't show. */
export function Note({ children, alert, last = true }: { children: string; alert?: boolean; last?: boolean }) {
  const c = useColors();
  return (
    <Block last={last}>
      <T alert={alert} muted={!alert} style={{ fontSize: 14, lineHeight: 19, ...(alert && { color: c.danger }) }}>
        {children}
      </T>
    </Block>
  );
}

/**
 * A titled text field that saves its value when editing ends, if it changed, as the desktop's
 * SavedField. A `required` one that's emptied goes back to `value`.
 */
export function Field({
  title,
  detail,
  value,
  onSave,
  placeholder,
  required,
  secure,
  mono,
  multiline,
  last,
}: {
  title: string;
  detail?: string;
  value: string;
  onSave: (value: string) => void;
  placeholder?: string;
  required?: boolean;
  secure?: boolean;
  mono?: boolean;
  multiline?: boolean;
  last?: boolean;
}) {
  const [text, setText] = useState(value);
  useEffect(() => setText(value), [value]);
  const done = () => {
    if (text === value) return;
    if (required && !text.trim()) setText(value);
    else onSave(text);
  };
  return (
    <Block last={last} style={{ gap: 4 }}>
      <T>{title}</T>
      {!!detail && (
        <T muted style={{ fontSize: 13, lineHeight: 18 }}>
          {detail}
        </T>
      )}
      <Input
        accessibilityLabel={title}
        value={text}
        onChangeText={setText}
        onEndEditing={done}
        placeholder={placeholder}
        secureTextEntry={secure}
        multiline={multiline}
        mono={mono}
        returnKeyType={multiline ? "default" : "done"}
        style={multiline && { minHeight: 64, textAlignVertical: "top" }}
      />
    </Block>
  );
}

/** A text box with no title, for forms: a key, a label, a name. */
export function Input(props: ComponentProps<typeof TextInput> & { mono?: boolean }) {
  const c = useColors();
  return (
    <TextInput
      placeholderTextColor={c.faintForeground}
      autoCapitalize="none"
      autoCorrect={false}
      spellCheck={false}
      {...props}
      style={[
        styles.input,
        { color: c.foreground, backgroundColor: c.code, borderColor: c.border },
        props.mono && { fontFamily: font.mono, fontSize: 13 },
        props.style,
      ]}
    />
  );
}

const styles = StyleSheet.create({
  block: { paddingHorizontal: 16, paddingVertical: 11 },
  input: {
    marginTop: 4,
    borderRadius: 10,
    borderWidth: StyleSheet.hairlineWidth,
    paddingHorizontal: 10,
    paddingVertical: 8,
    fontSize: 15,
  },
});
