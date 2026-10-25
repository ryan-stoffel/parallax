// The composer's "Add to thread" sheet, as Claude's app has it: a close button, the title, and
// Photos on top; a row with the camera and the library's recent photos, which attach as they're
// tapped; and Add files at the foot. Photos, Camera, and Add files put the sheet away first and
// open their picker once it's gone, since iOS presents one screen over another only when the
// first is done.
import { GlassView, isLiquidGlassAvailable } from "expo-glass-effect";
import * as Haptics from "expo-haptics";
import { Asset, AssetField, MediaType, Query, requestPermissionsAsync, type AssetMetadata } from "expo-media-library";
import { Camera, Check, FileText, X } from "lucide-react-native";
import { useEffect, useRef, useState } from "react";
import { Image, Linking, Pressable, StyleSheet, View } from "react-native";
import { ScrollView } from "react-native-gesture-handler";

import { GlassButton } from "./Glass";
import { Sheet, sheetTitle } from "./Sheet";
import { Icon, T, useColors } from "./ui";

const TILE = 104;
const RECENT = 30;
const glass = isLiquidGlassAvailable();

/**
 * The sheet, open while `open`. `selected` holds the ids of recent photos attached, which
 * `onToggle` attaches or takes off. `onPhotos`, `onCamera`, and `onFiles` open their pickers,
 * called once the sheet is down.
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
  onPhotos: () => void;
  onCamera: () => void;
  onFiles: () => void;
}) {
  const c = useColors();
  // Undefined until asked, the first time the sheet opens.
  const [allowed, setAllowed] = useState<boolean>();
  const [recent, setRecent] = useState<AssetMetadata[]>([]);
  // Each recent photo's file URL, by id: React Native's Image can't load a `ph://` id here.
  const [files, setFiles] = useState<ReadonlyMap<string, string>>(new Map());
  // The picker to open once the sheet is gone.
  const next = useRef<() => void>(undefined);

  useEffect(() => {
    if (!open) return;
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
        if (!live) return;
        setRecent(photos);
        const uris = await Promise.all(photos.map((p) => new Asset(p.id).getUri().catch(() => undefined)));
        if (live) setFiles(new Map(photos.flatMap((p, i) => (uris[i] ? [[p.id, uris[i]] as const] : []))));
      })
      .catch(() => live && setAllowed(false));
    return () => {
      live = false;
    };
  }, [open]);

  const pick = (then: () => void) => () => {
    next.current = then;
    onClose();
  };
  const toggle = (photo: AssetMetadata) => {
    void Haptics.selectionAsync();
    onToggle(photo);
  };

  return (
    <Sheet
      open={open}
      onClose={onClose}
      onDismissed={() => {
        const then = next.current;
        next.current = undefined;
        then?.();
      }}
      head={
        <View style={styles.head}>
          <T style={sheetTitle}>Add to thread</T>
          <GlassButton label="Close" size={40} onPress={onClose}>
            <Icon icon={X} size={20} color={c.foreground} />
          </GlassButton>
          <GlassView isInteractive style={[styles.pill, !glass && { backgroundColor: c.surface }]}>
            <Pressable
              accessibilityRole="button"
              onPress={pick(onPhotos)}
              style={[styles.center, { paddingHorizontal: 16 }]}
            >
              <T medium style={{ fontSize: 16 }}>
                Photos
              </T>
            </Pressable>
          </GlassView>
        </View>
      }
    >
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
                <Image
                  source={{ uri: files.get(p.id) }}
                  resizeMethod="resize"
                  style={[styles.tile, { backgroundColor: c.selected }]}
                />
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
    </Sheet>
  );
}

const styles = StyleSheet.create({
  head: {
    flexDirection: "row",
    alignItems: "center",
    justifyContent: "space-between",
    paddingHorizontal: 16,
    paddingBottom: 14,
  },
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
