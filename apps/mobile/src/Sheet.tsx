// The app's own sheets (the composer's model and attach sheets, and Choices), as iOS 26 floats
// them: a card rounded on every corner rising from the bottom over a light dim. Its grabber and
// header sit on the card's own background, and a drag down on them puts the sheet away, as a tap
// outside does.
import type { ReactNode } from "react";
import { useEffect, useState } from "react";
import { Modal, Pressable, StyleSheet, useWindowDimensions, View } from "react-native";
import { Gesture, GestureDetector, GestureHandlerRootView } from "react-native-gesture-handler";
import Animated, { useAnimatedStyle, useSharedValue, withSpring, withTiming } from "react-native-reanimated";
import { useSafeAreaInsets } from "react-native-safe-area-context";
import { scheduleOnRN } from "react-native-worklets";

import { useColors } from "./ui";

const spring = { damping: 24, stiffness: 260, mass: 1 };

/**
 * A sheet, up while `open`: it springs up when `open` turns true and slides down when it turns
 * false, so `onClose` only has to clear it. `head` is the draggable top under the grabber, and
 * `onDismissed` hears it gone, when something else can be presented.
 */
export function Sheet({
  open,
  onClose,
  onDismissed,
  head,
  children,
}: {
  open: boolean;
  onClose: () => void;
  onDismissed?: () => void;
  head?: ReactNode;
  children: ReactNode;
}) {
  const c = useColors();
  const insets = useSafeAreaInsets();
  const { height } = useWindowDimensions();
  const y = useSharedValue(height);
  // Up from opening until the slide down ends.
  const [shown, setShown] = useState(open);

  useEffect(() => {
    if (open) {
      setShown(true);
      y.value = withSpring(0, spring);
    } else y.value = withTiming(height, { duration: 220 }, (done) => done && scheduleOnRN(setShown, false));
  }, [open]);

  const pan = Gesture.Pan()
    .activeOffsetY([-6, 6])
    .onUpdate((e) => {
      // Down follows the finger; up gives a little, as a sheet at its top does.
      y.value = e.translationY > 0 ? e.translationY : e.translationY / 6;
    })
    .onEnd((e) => {
      if (e.translationY > 90 || e.velocityY > 800) {
        y.value = withTiming(height, { duration: 200 });
        scheduleOnRN(onClose);
      } else y.value = withSpring(0, spring);
    });
  const sheetStyle = useAnimatedStyle(() => ({ transform: [{ translateY: y.value }] }));
  // The dim fades as the sheet goes down.
  const scrimStyle = useAnimatedStyle(() => ({ opacity: Math.max(0, 1 - y.value / 400) }));

  return (
    <Modal visible={shown} transparent animationType="none" onRequestClose={onClose} onDismiss={onDismissed}>
      <GestureHandlerRootView style={{ flex: 1, justifyContent: "flex-end" }}>
        <Animated.View style={[StyleSheet.absoluteFill, styles.scrim, scrimStyle]}>
          <Pressable style={{ flex: 1 }} onPress={onClose} accessibilityLabel="Close" />
        </Animated.View>
        <Animated.View
          style={[
            styles.sheet,
            // It runs past the screen's bottom edge, so its bottom never shows, even as it springs.
            { backgroundColor: c.sidebar, marginBottom: -BELOW, paddingBottom: insets.bottom + 12 + BELOW },
            sheetStyle,
          ]}
        >
          <GestureDetector gesture={pan}>
            <View accessibilityHint="Drag down to close">
              <View style={styles.grab}>
                <View style={[styles.grabber, { backgroundColor: c.border }]} />
              </View>
              {head}
            </View>
          </GestureDetector>
          {children}
        </Animated.View>
      </GestureHandlerRootView>
    </Modal>
  );
}

/** How far a sheet runs past the screen's bottom edge. */
const BELOW = 60;

/** A sheet's title, centered over its header's buttons. */
export const sheetTitle = { position: "absolute", left: 0, right: 0, textAlign: "center", fontSize: 17, fontWeight: "600" } as const;

const styles = StyleSheet.create({
  scrim: { backgroundColor: "rgba(0, 0, 0, 0.12)" },
  sheet: {
    marginHorizontal: 8,
    borderRadius: 38,
    borderCurve: "continuous",
    shadowColor: "#000000",
    shadowOpacity: 0.18,
    shadowRadius: 30,
    shadowOffset: { width: 0, height: 8 },
  },
  // Taller than the grabber, so it's easy to catch.
  grab: { alignItems: "center", paddingTop: 8, paddingBottom: 10 },
  grabber: { width: 40, height: 5, borderRadius: 3 },
});
