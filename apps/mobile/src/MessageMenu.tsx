// A message's long-press menu, as iOS's context menus: the bubble lifts over a dim with a firm tap,
// moving up if the menu needs the room, and the menu springs open under it. Copy copies the text,
// Select text opens it in a sheet where iOS's own edit menu selects, copies, looks up, translates,
// and offers Writing Tools and Siri, and Edit, where the thread allows it, takes it back to edit.
import * as Clipboard from "expo-clipboard";
import * as Haptics from "expo-haptics";
import type { LucideIcon } from "lucide-react-native";
import { Copy, Pencil, TextCursor, X } from "lucide-react-native";
import { useEffect, useRef, useState, type ReactNode } from "react";
import { Modal, Pressable, StyleSheet, TextInput, useColorScheme, useWindowDimensions, View } from "react-native";
import Animated, { interpolate, useAnimatedStyle, useSharedValue, withSpring, withTiming } from "react-native-reanimated";
import { useSafeAreaInsets } from "react-native-safe-area-context";
import { scheduleOnRN } from "react-native-worklets";

import { GlassButton } from "./Glass";
import { Sheet, sheetTitle } from "./Sheet";
import { font } from "./theme";
import { Icon, T, useColors } from "./ui";

const spring = { damping: 22, stiffness: 320, mass: 0.8 };
const ROW = 46;
const MENU_WIDTH = 240;

interface Frame {
  x: number;
  y: number;
  width: number;
  height: number;
}

interface Action {
  label: string;
  icon: LucideIcon;
  run: () => void;
  /** Waits for the menu to go, as iOS presents one screen only once another is gone. */
  after?: boolean;
}

/**
 * `children`, the message's bubble, which a long press lifts into the menu. `text` is what Copy and
 * Select text take, and `onEdit`, when given, offers Edit.
 */
export function MessageMenu({ text, onEdit, children }: { text: string; onEdit?: () => void; children: ReactNode }) {
  const c = useColors();
  const scheme = useColorScheme();
  const insets = useSafeAreaInsets();
  const { height: screen } = useWindowDimensions();
  const ref = useRef<View>(null);
  // Where the bubble was when pressed, while the menu is up.
  const [frame, setFrame] = useState<Frame>();
  const [selecting, setSelecting] = useState(false);
  const progress = useSharedValue(0);
  const next = useRef<() => void>(undefined);

  const actions: Action[] = [
    { label: "Copy", icon: Copy, run: () => void Clipboard.setStringAsync(text) },
    { label: "Select text", icon: TextCursor, run: () => setSelecting(true), after: true },
    ...(onEdit ? [{ label: "Edit", icon: Pencil, run: onEdit }] : []),
  ];

  const lift = () =>
    ref.current?.measureInWindow((x, y, width, height) => {
      void Haptics.impactAsync(Haptics.ImpactFeedbackStyle.Medium);
      setFrame({ x, y, width, height });
    });
  useEffect(() => {
    if (frame) progress.value = withSpring(1, spring);
  }, [frame]);
  const close = () => {
    progress.value = withTiming(0, { duration: 160 }, (done) => done && scheduleOnRN(setFrame, undefined));
  };
  const pick = (action: Action) => () => {
    void Haptics.selectionAsync();
    if (action.after) next.current = action.run;
    else action.run();
    close();
  };

  // The bubble moves up as far as the menu under it needs, but never past the top; a bubble too
  // tall for both shows its top.
  const menuHeight = actions.length * ROW;
  const floor = screen - insets.bottom - 12;
  const ceiling = insets.top + 12;
  const top = frame ? Math.max(ceiling, Math.min(frame.y, floor - menuHeight - 10 - frame.height)) : 0;
  const shownHeight = frame ? Math.min(frame.height, floor - menuHeight - 10 - top) : 0;
  const shift = frame ? top - frame.y : 0;

  const scrim = useAnimatedStyle(() => ({ opacity: progress.value }));
  const preview = useAnimatedStyle(() => ({
    transform: [{ translateY: shift * progress.value }, { scale: interpolate(progress.value, [0, 1], [1, 1.03]) }],
  }));
  const menu = useAnimatedStyle(() => ({
    opacity: progress.value,
    transform: [{ translateY: shift * progress.value }, { scale: interpolate(progress.value, [0, 1], [0.6, 1]) }],
  }));

  return (
    <>
      <Pressable
        ref={ref}
        onLongPress={lift}
        delayLongPress={320}
        accessibilityHint="Double-tap and hold for Copy, Select text, and Edit"
        style={{ maxWidth: "85%", opacity: frame ? 0 : 1 }}
      >
        {children}
      </Pressable>
      <Modal
        visible={!!frame}
        transparent
        animationType="none"
        onRequestClose={close}
        onDismiss={() => {
          const then = next.current;
          next.current = undefined;
          then?.();
        }}
      >
        {frame && (
          <View style={{ flex: 1 }}>
            <Animated.View
              style={[
                StyleSheet.absoluteFill,
                { backgroundColor: scheme === "dark" ? "rgba(0, 0, 0, 0.55)" : "rgba(14, 12, 40, 0.22)" },
                scrim,
              ]}
            >
              <Pressable style={{ flex: 1 }} onPress={close} accessibilityLabel="Close menu" />
            </Animated.View>
            <Animated.View
              pointerEvents="none"
              style={[
                { position: "absolute", left: frame.x, top: frame.y, width: frame.width, height: shownHeight, overflow: "hidden" },
                preview,
              ]}
            >
              {children}
            </Animated.View>
            <Animated.View
              style={[
                styles.menu,
                {
                  top: frame.y + shownHeight + 10,
                  left: Math.max(12, frame.x + frame.width - MENU_WIDTH),
                  backgroundColor: c.surface,
                  borderColor: c.border,
                },
                menu,
              ]}
            >
              {/* Clipped inside, so the card's shadow still shows. */}
              <View style={styles.clip}>
              {actions.map((a, i) => (
                <Pressable
                  key={a.label}
                  accessibilityRole="menuitem"
                  onPress={pick(a)}
                  style={({ pressed }) => [
                    styles.row,
                    i > 0 && { borderTopWidth: StyleSheet.hairlineWidth, borderTopColor: c.border },
                    pressed && { backgroundColor: c.selected },
                  ]}
                >
                  <T style={{ fontSize: 16 }}>{a.label}</T>
                  <Icon icon={a.icon} size={18} />
                </Pressable>
              ))}
              </View>
            </Animated.View>
          </View>
        )}
      </Modal>
      <SelectText text={text} open={selecting} onClose={() => setSelecting(false)} />
    </>
  );
}

/**
 * A message in a sheet as read-only text, so a long press or a double tap selects in it and iOS's
 * own edit menu offers Copy, Look Up, Translate, Writing Tools, and Siri where the system has them.
 */
function SelectText({ text, open, onClose }: { text: string; open: boolean; onClose: () => void }) {
  const c = useColors();
  const { height } = useWindowDimensions();
  return (
    <Sheet
      open={open}
      onClose={onClose}
      head={
        <View style={styles.head}>
          <T style={sheetTitle}>Select text</T>
          <GlassButton label="Close" size={40} onPress={onClose}>
            <Icon icon={X} size={20} color={c.foreground} />
          </GlassButton>
        </View>
      }
    >
      <TextInput
        value={text}
        readOnly
        multiline
        scrollEnabled
        accessibilityLabel="Message text"
        selectionColor={c.accent}
        style={[styles.text, { color: c.foreground, maxHeight: height * 0.6, fontFamily: font.regular }]}
      />
    </Sheet>
  );
}

const styles = StyleSheet.create({
  menu: {
    position: "absolute",
    width: MENU_WIDTH,
    borderRadius: 16,
    borderCurve: "continuous",
    borderWidth: StyleSheet.hairlineWidth,
    transformOrigin: "top right",
    shadowColor: "#000000",
    shadowOpacity: 0.2,
    shadowRadius: 24,
    shadowOffset: { width: 0, height: 8 },
  },
  clip: { borderRadius: 16, borderCurve: "continuous", overflow: "hidden" },
  row: { height: ROW, flexDirection: "row", alignItems: "center", justifyContent: "space-between", paddingHorizontal: 16 },
  head: { flexDirection: "row", alignItems: "center", paddingHorizontal: 16, paddingBottom: 10 },
  text: { fontSize: 16, lineHeight: 23, paddingHorizontal: 20, paddingTop: 4, paddingBottom: 12 },
});
