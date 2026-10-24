// The composer's "Add to thread" sheet, as Claude's app has it: a close button, the title, and
// Photos on top; a row with the camera and the library's recent photos, which attach as they're
// tapped; and Add files at the foot. It springs up, and a swipe down or the X puts it away.
import { GlassView, isLiquidGlassAvailable } from "expo-glass-effect";
import * as Haptics from "expo-haptics";
import { AssetField, MediaType, Query, requestPermissionsAsync, type AssetMetadata } from "expo-media-library";
import { Camera, Check, FileText, X } from "lucide-react-native";
import { useEffect, useState } from "react";
import { Image, Linking, Modal, Pressable, StyleSheet, useWindowDimensions, View } from "react-native";
import { Gesture, GestureDetector, GestureHandlerRootView, ScrollView } from "react-native-gesture-handler";
import Animated, { useAnimatedStyle, useSharedValue, withSpring, withTiming } from "react-native-reanimated";
import { useSafeAreaInsets } from "react-native-safe-area-context";
import { scheduleOnRN } from "react-native-worklets";

import { Icon, T, useColors } from "./ui";

const TILE = 104;
const RECENT = 30;
const spring = { damping: 24, stiffness: 260, mass: 1 };
const glass = isLiquidGlassAvailable();

/**
 * The sheet, open while `open`. `selected` holds the ids of recent photos attached, which
 * `onToggle` attaches or takes off. `onPhotos`, `onCamera`, and `onFiles` resolve to whether
 * something was picked, which closes the sheet.
 */
export function AttachSheet({
  open,
  onClose,
  selected,
  onToggle,
  onPhotos,
  onCamera,
  onFiles,
}: {
  open: boolean;
  onClose: () => void;
  selected: string[];
  onToggle: (photo: AssetMetadata) => void;
  onPhotos: () => Promise<boolean>;
  onCamera: () => Promise<boolean>;
  onFiles: () => Promise<boolean>;
}) {
  const c = useColors();
  const insets = useSafeAreaInsets();
  const { height } = useWindowDimensions();
  const y = useSharedValue(height);
  // Undefined until asked, the first time the sheet opens.
  const [allowed, setAllowed] = useState<boolean>();
  const [recent, setRecent] = useState<AssetMetadata[]>([]);

  useEffect(() => {
    if (!open) return;
    y.value = withSpring(0, spring);
    let live = true;
    // Asks only the first time; after that it reads the answer, and limited access lists only the
    // photos it allows.
    void requestPermissionsAsync()
      .then(async (p) => {
        if (!live) return;
        setAllowed(p.granted);
        if (!p.granted) return;
        const photos = await new Query()
          .eq(AssetField.MEDIA_TYPE, MediaType.IMAGE)
          .orderBy({ key: AssetField.CREATION_TIME, ascending: false })
          .limit(RECENT)
          .exeForMetadata();
        if (live) setRecent(photos);
      })
      .catch(() => live && setAllowed(false));
    return () => {
      live = false;
    };
  }, [open]);

  const dismiss = () => {
    y.value = withTiming(height, { duration: 220 }, (done) => done && scheduleOnRN(onClose));
  };
  const pan = Gesture.Pan()
    .activeOffsetY([-10, 10])
    .failOffsetX([-12, 12])
    .onUpdate((e) => {
      // Down follows the finger; up gives a little, as a sheet at its top does.
      y.value = e.translationY > 0 ? e.translationY : e.translationY / 6;
    })
    .onEnd((e) => {
      if (e.translationY > 110 || e.velocityY > 900)
        y.value = withTiming(height, { duration: 200 }, (done) => done && scheduleOnRN(onClose));
      else y.value = withSpring(0, spring);
    });
  const sheetStyle = useAnimatedStyle(() => ({ transform: [{ translateY: y.value }] }));
  // A light dim that fades as the sheet goes down.
  const scrimStyle = useAnimatedStyle(() => ({ opacity: Math.max(0, 1 - y.value / 400) }));

  const pick = (then: () => Promise<boolean>) => () => void then().then((picked) => picked && dismiss());
  const toggle = (photo: AssetMetadata) => {
    void Haptics.selectionAsync();
    onToggle(photo);
  };
  const circle = [styles.circle, !glass && { backgroundColor: c.surface }];

  return (
    <Modal visible={open} transparent animationType="none" onRequestClose={dismiss}>
      <GestureHandlerRootView style={{ flex: 1, justifyContent: "flex-end" }}>
        <Animated.View style={[StyleSheet.absoluteFill, styles.scrim, scrimStyle]}>
          <Pressable style={{ flex: 1 }} onPress={dismiss} accessibilityLabel="Close" />
        </Animated.View>
        <GestureDetector gesture={pan}>
          <Animated.View
            style={[
              styles.sheet,
              { backgroundColor: c.sidebar, marginBottom: Math.max(insets.bottom - 26, 8) },
              sheetStyle,
            ]}
          >
            <View style={[styles.grabber, { backgroundColor: c.border }]} />
            <View style={styles.head}>
              <T style={styles.title}>
                Add to thread
              </T>
              <GlassView isInteractive style={circle}>
                <Pressable accessibilityRole="button" accessibilityLabel="Close" onPress={dismiss} style={styles.center}>
                  <Icon icon={X} size={20} color={c.foreground} />
                </Pressable>
              </GlassView>
              <GlassView isInteractive style={[styles.pill, !glass && { backgroundColor: c.surface }]}>
                <Pressable accessibilityRole="button" onPress={pick(onPhotos)} style={[styles.center, { paddingHorizontal: 16 }]}>
                  <T medium style={{ fontSize: 16 }}>
                    Photos
                  </T>
                </Pressable>
              </GlassView>
            </View>
            <ScrollView horizontal showsHorizontalScrollIndicator={false} contentContainerStyle={styles.gallery}>
              <Pressable
                accessibilityRole="button"
                onPress={pick(onCamera)}
                style={({ pressed }) => [styles.tile, styles.camera, { backgroundColor: pressed ? c.hover : c.surface }]}
              >
                <Icon icon={Camera} size={26} color={c.foreground} />
                <T style={{ fontSize: 14 }}>Camera</T>
              </Pressable>
              {allowed &&
                recent.map((p) => {
                  const on = selected.includes(p.id);
                  return (
                    <Pressable
                      key={p.id}
                      accessibilityRole="button"
                      accessibilityLabel="Photo"
                      accessibilityState={{ selected: on }}
                      onPress={() => toggle(p)}
                    >
                      {/* `ph://` ids load through expo-media-library's image loader, at the tile's size. */}
                      <Image source={{ uri: p.id }} style={[styles.tile, { backgroundColor: c.selected }]} />
                      {on && (
                        <View style={[styles.check, { backgroundColor: c.accent }]}>
                          <Icon icon={Check} size={14} color="#ffffff" strokeWidth={3} />
                        </View>
                      )}
                    </Pressable>
                  );
                })}
            </ScrollView>
            {allowed === false && (
              <View style={styles.denied}>
                <T muted style={{ fontSize: 14, flex: 1 }}>
                  Allow access to your photos to see recent ones here.
                </T>
                <Pressable accessibilityRole="button" hitSlop={8} onPress={() => void Linking.openSettings()}>
                  <T medium style={{ fontSize: 14, color: c.accent }}>
                    Open Settings
                  </T>
                </Pressable>
              </View>
            )}
            <Pressable
              accessibilityRole="button"
              onPress={pick(onFiles)}
              style={({ pressed }) => [styles.files, { backgroundColor: pressed ? c.hover : c.surface }]}
            >
              <Icon icon={FileText} size={20} color={c.foreground} />
              <T medium style={{ fontSize: 16 }}>
                Add files
              </T>
            </Pressable>
          </Animated.View>
        </GestureDetector>
      </GestureHandlerRootView>
    </Modal>
  );
}

const styles = StyleSheet.create({
  scrim: { backgroundColor: "rgba(0, 0, 0, 0.12)" },
  // Floating, rounded on every corner, as the composer's model sheet is.
  sheet: {
    marginHorizontal: 8,
    borderRadius: 38,
    paddingTop: 8,
    paddingBottom: 16,
    shadowColor: "#000000",
    shadowOpacity: 0.18,
    shadowRadius: 30,
    shadowOffset: { width: 0, height: 8 },
  },
  grabber: { alignSelf: "center", width: 40, height: 5, borderRadius: 3, marginBottom: 8 },
  head: {
    flexDirection: "row",
    alignItems: "center",
    justifyContent: "space-between",
    paddingHorizontal: 16,
    paddingBottom: 14,
  },
  title: { position: "absolute", left: 0, right: 0, textAlign: "center", fontSize: 17, fontWeight: "600" },
  circle: { width: 40, height: 40, borderRadius: 20 },
  pill: { height: 40, borderRadius: 20 },
  center: { flex: 1, alignItems: "center", justifyContent: "center" },
  gallery: { gap: 8, paddingHorizontal: 16 },
  tile: { width: TILE, height: TILE, borderRadius: 16 },
  camera: { alignItems: "center", justifyContent: "center", gap: 6 },
  check: {
    position: "absolute",
    top: 6,
    right: 6,
    width: 24,
    height: 24,
    borderRadius: 12,
    borderWidth: 2,
    borderColor: "#ffffff",
    alignItems: "center",
    justifyContent: "center",
  },
  denied: { flexDirection: "row", alignItems: "center", gap: 12, paddingHorizontal: 20, paddingTop: 12 },
  files: {
    flexDirection: "row",
    alignItems: "center",
    justifyContent: "center",
    gap: 8,
    height: 52,
    borderRadius: 20,
    marginHorizontal: 16,
    marginTop: 16,
  },
});
