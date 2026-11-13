// The app's own dialogs, menus, and notices, for dialogStore.ts: a card over a dim, a sheet of rows
// from the bottom, and a banner at the top that doesn't block the screen. On iOS they're drawn in
// their own window, as a Modal from here can't show over a native form sheet such as Settings. On
// Android a form sheet is in the app's own view tree, under this last view at its root.
import * as Haptics from "expo-haptics";
import { t } from "i18next";
import { Check, CircleAlert } from "lucide-react-native";
import { useEffect, useRef, useState, useSyncExternalStore, type ReactNode } from "react";
import { AccessibilityInfo, Keyboard, Platform, Pressable, ScrollView, StyleSheet, useWindowDimensions, View } from "react-native";
import { GestureHandlerRootView } from "react-native-gesture-handler";
import Animated, { FadeIn, FadeInDown, FadeInUp, FadeOut, FadeOutUp, SlideOutDown, ZoomIn } from "react-native-reanimated";
import { useSafeAreaInsets } from "react-native-safe-area-context";
import { FullWindowOverlay } from "react-native-screens";

import { clearNotice, dialogState, finish, subscribe, type Dialog, type DialogButton, type MenuItem, type Notice } from "./dialogStore";
import { Button, Icon, Input, T, useColors } from "./ui";

const NOTICE_MS = 5000;
/** How long a dialog's window stays after it's put away, for its exit. */
const EXIT_MS = 240;

/** Over everything. `FullWindowOverlay` is iOS-only, and elsewhere draws its children in a view of no size. */
const Overlay =
  Platform.OS === "ios"
    ? FullWindowOverlay
    : ({ children }: { children: ReactNode }) => (
        <View style={StyleSheet.absoluteFill} pointerEvents="box-none">
          {children}
        </View>
      );

/** Draws what dialogStore holds. Mounted once, at the app's root. */
export function Dialogs() {
  const { dialog, notice } = useSyncExternalStore(subscribe, dialogState);
  const showing = !!dialog || !!notice;
  const [mounted, setMounted] = useState(showing);
  useEffect(() => {
    if (showing) return setMounted(true);
    const later = setTimeout(() => setMounted(false), EXIT_MS);
    return () => clearTimeout(later);
  }, [showing]);
  if (!mounted) return null;
  return (
    <Overlay>
      <GestureHandlerRootView style={StyleSheet.absoluteFill} pointerEvents="box-none">
        {dialog?.kind === "menu" ? (
          <MenuSheet key={keyOf(dialog)} dialog={dialog} />
        ) : dialog ? (
          <DialogCard key={keyOf(dialog)} dialog={dialog} />
        ) : null}
        {notice && <Banner key={notice.id} notice={notice} />}
      </GestureHandlerRootView>
    </Overlay>
  );
}

/**
 * Puts the current dialog away, then does what it was for, once the keyboard and this window have
 * gone. A page pushed before then opens without its header's inset, with its top under the header.
 */
function putAway(run: () => void) {
  let done = false;
  const go = () => {
    if (done) return;
    done = true;
    hidden.remove();
    setTimeout(run, EXIT_MS + 60);
  };
  const hidden = Keyboard.addListener("keyboardDidHide", go);
  const typing = Keyboard.isVisible();
  Keyboard.dismiss();
  finish();
  if (!typing) return go();
  // In case the keyboard never says so, what the button does still happens.
  setTimeout(go, 600);
}

// A new key for each dialog, so one following another starts fresh, with its own text.
const keys = new WeakMap<Dialog, number>();
let nextKey = 0;
function keyOf(dialog: Dialog) {
  let key = keys.get(dialog);
  if (key === undefined) keys.set(dialog, (key = ++nextKey));
  return key;
}

function Scrim({ onPress, opacity }: { onPress?: () => void; opacity: number }) {
  return (
    <Animated.View
      entering={FadeIn.duration(140)}
      exiting={FadeOut.duration(140)}
      style={[StyleSheet.absoluteFill, { backgroundColor: `rgba(0, 0, 0, ${opacity})` }]}
    >
      <Pressable style={{ flex: 1 }} onPress={onPress} accessibilityLabel={onPress ? t("Close") : undefined} />
    </Animated.View>
  );
}

/** A confirmation or a prompt, in a card over the dim. Two buttons sit side by side, more stack. */
function DialogCard({ dialog }: { dialog: Exclude<Dialog, { kind: "menu" }> }) {
  const c = useColors();
  const insets = useSafeAreaInsets();
  const { width, height } = useWindowDimensions();
  const [value, setValue] = useState(dialog.kind === "prompt" ? dialog.value : "");
  const [lifted, setLifted] = useState(0);
  const cancel = dialog.buttons.find((b) => b.style === "cancel");
  const press = (button?: DialogButton) =>
    putAway(() => button?.onPress?.(dialog.kind === "prompt" ? value : undefined));
  // The last button that isn't Cancel or destructive is the one Return presses.
  const preferred = [...dialog.buttons].reverse().find((b) => b.style !== "cancel" && b.style !== "destructive");

  useEffect(() => {
    const show = Keyboard.addListener(Platform.OS === "ios" ? "keyboardWillShow" : "keyboardDidShow", (e) => setLifted(e.endCoordinates.height));
    const hide = Keyboard.addListener(Platform.OS === "ios" ? "keyboardWillHide" : "keyboardDidHide", () => setLifted(0));
    return () => {
      show.remove();
      hide.remove();
    };
  }, []);

  const stacked = dialog.buttons.length !== 2 || dialog.buttons.some((b) => b.text.length > 14);
  return (
    <View style={StyleSheet.absoluteFill} accessibilityViewIsModal>
      <Scrim opacity={0.45} onPress={cancel && (() => press(cancel))} />
      <View style={[styles.center, { paddingBottom: lifted }]} pointerEvents="box-none">
        <Animated.View
          entering={ZoomIn.springify().damping(22).stiffness(320).mass(0.7)}
          exiting={FadeOut.duration(120)}
          accessibilityRole="alert"
          style={[
            styles.card,
            {
              width: Math.min(width - 48, 340),
              maxHeight: height - insets.top - Math.max(insets.bottom, lifted) - 32,
              backgroundColor: c.surface,
              borderColor: c.border,
            },
          ]}
        >
          {/* Text of any length scrolls, so the buttons stay on screen. */}
          <ScrollView style={{ flexGrow: 0, flexShrink: 1 }} contentContainerStyle={{ gap: 8 }} alwaysBounceVertical={false}>
            <T style={styles.title}>{dialog.title}</T>
            {!!dialog.message && (
              <T muted style={styles.message}>
                {dialog.message}
              </T>
            )}
          </ScrollView>
          {dialog.kind === "prompt" && (
            <Input
              autoFocus
              value={value}
              onChangeText={setValue}
              secureTextEntry={dialog.secure}
              keyboardType={dialog.keyboardType}
              accessibilityLabel={dialog.title}
              returnKeyType="done"
              onSubmitEditing={() => press(preferred)}
              style={{ marginTop: 6 }}
            />
          )}
          <View style={[styles.buttons, !stacked && { flexDirection: "row" }]}>
            {dialog.buttons.map((b) => (
              <Button
                key={b.text}
                label={b.text}
                onPress={() => press(b)}
                primary={b === preferred}
                destructive={b.style === "destructive"}
                style={stacked ? undefined : { flex: 1 }}
              />
            ))}
          </View>
        </Animated.View>
      </View>
    </View>
  );
}

/** A menu, in the same floating card as the app's sheets. */
function MenuSheet({ dialog }: { dialog: Extract<Dialog, { kind: "menu" }> }) {
  const c = useColors();
  const insets = useSafeAreaInsets();
  const { height } = useWindowDimensions();
  const close = () => finish();
  const press = (item: MenuItem) => {
    void Haptics.selectionAsync();
    putAway(item.onPress);
  };
  return (
    <View style={StyleSheet.absoluteFill} accessibilityViewIsModal>
      <Scrim opacity={0.25} onPress={close} />
      <View style={{ flex: 1, justifyContent: "flex-end" }} pointerEvents="box-none">
        <Animated.View
          entering={FadeInDown.springify().damping(24).stiffness(260)}
          exiting={SlideOutDown.duration(200)}
          style={[
            styles.sheet,
            { marginBottom: Math.max(insets.bottom, 8), backgroundColor: c.surface, borderColor: c.border, maxHeight: height * 0.7 },
          ]}
        >
          {!!dialog.title && (
            <T muted style={styles.menuTitle} numberOfLines={2}>
              {dialog.title}
            </T>
          )}
          <ScrollView bounces={false} alwaysBounceVertical={false}>
            {dialog.items.map((item) => {
              const color = item.destructive ? c.danger : c.foreground;
              return (
                <Pressable
                  key={item.label}
                  accessibilityRole="button"
                  accessibilityState={{ selected: !!item.checked }}
                  onPress={() => press(item)}
                  style={({ pressed }) => [styles.item, pressed && { backgroundColor: c.selected }]}
                >
                  {item.icon && <Icon icon={item.icon} size={18} color={item.destructive ? c.danger : c.mutedForeground} />}
                  <View style={{ flex: 1 }}>
                    <T style={{ color }} numberOfLines={2}>
                      {item.label}
                    </T>
                    {!!item.detail && (
                      <T muted style={{ fontSize: 13, lineHeight: 18 }}>
                        {item.detail}
                      </T>
                    )}
                  </View>
                  {item.checked && <Icon icon={Check} size={17} color={c.accent} />}
                </Pressable>
              );
            })}
          </ScrollView>
        </Animated.View>
      </View>
    </View>
  );
}

/** A banner at the top that says what happened and goes by itself. A tap puts it away sooner. */
function Banner({ notice }: { notice: Notice }) {
  const c = useColors();
  const insets = useSafeAreaInsets();
  const said = useRef(false);
  useEffect(() => {
    if (!said.current) {
      said.current = true;
      void Haptics.notificationAsync(Haptics.NotificationFeedbackType.Warning);
      AccessibilityInfo.announceForAccessibility([notice.title, notice.message].filter(Boolean).join(". "));
    }
    const later = setTimeout(() => clearNotice(notice.id), NOTICE_MS);
    return () => clearTimeout(later);
  }, [notice.id]);
  return (
    <View style={[styles.bannerWrap, { top: insets.top + 6 }]} pointerEvents="box-none">
      <Animated.View entering={FadeInUp.springify().damping(22).stiffness(280)} exiting={FadeOutUp.duration(160)}>
        <Pressable
          accessibilityRole="alert"
          accessibilityHint={t("Tap to dismiss")}
          onPress={() => clearNotice(notice.id)}
          style={[styles.banner, { backgroundColor: c.surface, borderColor: c.border }]}
        >
          <Icon icon={CircleAlert} size={18} color={c.mutedForeground} />
          <View style={{ flex: 1 }}>
            <T medium style={{ fontSize: 14, lineHeight: 19 }}>
              {notice.title}
            </T>
            {!!notice.message && (
              <T muted numberOfLines={4} style={{ fontSize: 13, lineHeight: 18 }}>
                {notice.message}
              </T>
            )}
          </View>
        </Pressable>
      </Animated.View>
    </View>
  );
}

const styles = StyleSheet.create({
  center: { flex: 1, alignItems: "center", justifyContent: "center" },
  card: {
    borderRadius: 24,
    borderCurve: "continuous",
    borderWidth: StyleSheet.hairlineWidth,
    padding: 20,
    gap: 8,
    shadowColor: "#000000",
    shadowOpacity: 0.25,
    shadowRadius: 30,
    shadowOffset: { width: 0, height: 10 },
  },
  title: { fontSize: 17, lineHeight: 22, fontWeight: "600" },
  message: { fontSize: 14, lineHeight: 20 },
  buttons: { gap: 8, marginTop: 12 },
  sheet: {
    marginHorizontal: 8,
    paddingVertical: 8,
    borderRadius: 28,
    borderCurve: "continuous",
    borderWidth: StyleSheet.hairlineWidth,
    overflow: "hidden",
    shadowColor: "#000000",
    shadowOpacity: 0.2,
    shadowRadius: 30,
    shadowOffset: { width: 0, height: 8 },
  },
  menuTitle: { fontSize: 13, lineHeight: 18, paddingHorizontal: 20, paddingTop: 8, paddingBottom: 6 },
  item: { flexDirection: "row", alignItems: "center", gap: 12, paddingHorizontal: 20, paddingVertical: 13 },
  bannerWrap: { position: "absolute", left: 12, right: 12 },
  banner: {
    flexDirection: "row",
    alignItems: "center",
    gap: 10,
    paddingHorizontal: 14,
    paddingVertical: 11,
    borderRadius: 18,
    borderCurve: "continuous",
    borderWidth: StyleSheet.hairlineWidth,
    shadowColor: "#000000",
    shadowOpacity: 0.2,
    shadowRadius: 20,
    shadowOffset: { width: 0, height: 6 },
  },
});
